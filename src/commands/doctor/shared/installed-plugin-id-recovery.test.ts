import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../../../config/config.js";
import { hashConfigRaw } from "../../../config/io.read-helpers.js";
import * as temporaryState from "../../../infra/tmp-openclaw-dir.js";
import { captureUpdateDoctorConfigWrites } from "../../../infra/update-doctor-result.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../../infra/update-managed-service-handoff-lease.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  assertInstalledPluginIdRecoveryCurrent,
  recoverInstalledPluginConfigIds,
} from "./installed-plugin-id-recovery.js";
import { seedRecoveryOwner } from "./installed-plugin-id-recovery.test-support.js";

describe("installed plugin recovery after same-run repair", () => {
  it.each(["repaired", "not-repaired", "different-root", "record-drift"] as const)(
    "keeps the commit fence after %s",
    async (scenario) => {
      await withOpenClawTestState(
        { label: `recovery-${scenario}`, env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
        async (state) => {
          const cfg = {
            plugins: { entries: { qqbot: { enabled: false, config: { authored: true } } } },
          };
          await seedRecoveryOwner(state, cfg, { version: "2.0.1" });
          const planned = await recoverInstalledPluginConfigIds(cfg, state.env);
          expect(planned.recovery.size).toBe(1);
          expect(planned.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(false);
          await assertInstalledPluginIdRecoveryCurrent(planned.config, planned.recovery, state.env);
          const repaired = await seedRecoveryOwner(state, planned.config, {
            version: "2.0.3",
            ...(scenario === "different-root" ? { root: state.path("other-owner") } : {}),
          });
          const result = await recoverInstalledPluginConfigIds(planned.config, state.env, {
            previousRecovery: planned.recovery,
            repairedPluginIds: scenario === "not-repaired" ? [] : ["openclaw-qqbot"],
            records: scenario === "record-drift" ? {} : repaired.records,
          });
          expect(result.config).toEqual(planned.config);
          const recovery = new Map([...planned.recovery, ...result.recovery]);
          const validate = () =>
            assertInstalledPluginIdRecoveryCurrent(result.config, recovery, state.env);
          if (scenario !== "repaired") {
            await expect(validate()).rejects.toThrow("Plugin ownership changed");
            return;
          }
          await expect(validate()).resolves.toBeUndefined();
          // Even the refreshed receipt must reject drift after Doctor's own repair.
          await fs.appendFile(path.join(repaired.root, "openclaw.plugin.json"), "\n");
          await expect(validate()).rejects.toThrow("Plugin ownership changed");
        },
      );
    },
  );
});

// Model a catalog-declared alias; catalog ingestion has separate owner coverage.
vi.mock("../../../plugins/official-external-plugin-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../plugins/official-external-plugin-catalog.js")>();
  return {
    ...actual,
    resolveOfficialExternalPluginLegacyIds: (
      entry: Parameters<typeof actual.resolveOfficialExternalPluginLegacyIds>[0],
    ) =>
      actual.resolveOfficialExternalPluginId(entry) === "openclaw-qqbot"
        ? ["qqbot"]
        : actual.resolveOfficialExternalPluginLegacyIds(entry),
  };
});

let handoffRoot: string;
beforeEach(async () => {
  handoffRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-id-recovery-"));
  await fs.chmod(handoffRoot, 0o700);
  const databasePath = path.join(handoffRoot, "managed-update-handoffs.sqlite");
  await fs.writeFile(databasePath, "", { mode: 0o600 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(handoffRoot);
  expect(resolveManagedUpdateLeaseDatabasePath()).toBe(databasePath);
  expect(await fs.realpath(databasePath)).toBe(
    path.join(await fs.realpath(handoffRoot), "managed-update-handoffs.sqlite"),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(handoffRoot, { recursive: true, force: true });
});

it.each([
  "standalone",
  "update",
  "environment-rotation",
  "include-drift",
  "owner-drift",
  "diagnostic-failure",
] as const)("sequences a root roster and nested plugin include (%s)", async (scenario) => {
  const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
  const { runWriteConfigHealth } =
    await import("../../../flows/doctor-health-contribution-runners.config.js");
  await withOpenClawTestState(
    {
      label: "doctor-roster-plugin-include",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        RECOVERY_VALUE: "synthetic-resolved",
        ROOT_VALUE: "synthetic-planning",
      },
    },
    async (state) => {
      const plugins = {
        enabled: false,
        allow: ["qqbot"],
        deny: ["qqbot"],
        entries: { qqbot: { enabled: false, config: { token: "${RECOVERY_VALUE}" } } },
      };
      const cfg = { agents: { defaults: { workspace: state.path("workspace") } }, plugins };
      await state.writeConfig({
        ...cfg,
        gateway: {
          mode: "local",
          ...(scenario === "environment-rotation"
            ? { auth: { mode: "token", token: "${ROOT_VALUE}" } }
            : {}),
        },
        plugins: { $include: "./plugin-parent.json" },
      });
      const parent = state.statePath("plugin-parent.json");
      const leaf = state.statePath("plugins.json");
      const parentRaw = JSON.stringify({ $include: "./plugins.json" });
      const leafRaw = JSON.stringify(plugins);
      await fs.writeFile(parent, parentRaw);
      await fs.writeFile(leaf, leafRaw);
      const owner = await seedRecoveryOwner(state, cfg);
      const rootRaw = await fs.readFile(state.configPath, "utf8");
      const ctx = await prepareDoctorContext(state.configPath);
      expect(ctx.configResult.persistCanonicalAgentRoster).toBe(true);
      expect(ctx.configResult.skipWizardMetadataForIncludeWrite).toBe(true);
      expect(ctx.configResult.referenceSource?.installedPluginIdRecovery?.size).toBe(1);
      const transform = configModule.transformConfigFile;
      let firstCommit: Awaited<ReturnType<typeof transform>> | undefined;
      vi.spyOn(configModule, "transformConfigFile").mockImplementation(async (params) => {
        const result = await transform(params);
        if (!firstCommit) {
          firstCommit = result;
          if (scenario === "include-drift") {
            await fs.appendFile(leaf, "\n");
          } else if (scenario === "owner-drift") {
            await fs.appendFile(path.join(owner.root, "openclaw.plugin.json"), "\n");
          }
        }
        return result;
      });
      if (scenario === "diagnostic-failure") {
        vi.mocked(ctx.runtime.log).mockImplementation(() => {
          throw new Error("fixture post-roster diagnostic failure");
        });
      }
      const write = () =>
        captureUpdateDoctorConfigWrites(
          state.configPath,
          () => runWriteConfigHealth(ctx, { runPostWriteRepairs: false }),
          scenario === "standalone"
            ? undefined
            : { inputHash: hashConfigRaw(rootRaw), assertCurrent: () => {} },
        );
      if (scenario === "diagnostic-failure") {
        await expect(write()).rejects.toThrow("fixture post-roster diagnostic failure");
      } else {
        const success =
          scenario === "environment-rotation"
            ? await withEnvAsync({ ROOT_VALUE: "synthetic-write" }, write)
            : await write();
        expect(success).toBe(["standalone", "update", "environment-rotation"].includes(scenario));
      }
      expect(firstCommit).toBeDefined();
      const saved = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(saved.agents.entries).toHaveProperty("main");
      expect(saved.plugins).toEqual({ $include: "./plugin-parent.json" });
      await expect(fs.readFile(parent, "utf8")).resolves.toBe(parentRaw);
      await expect(fs.readFile(state.configPath + ".bak", "utf8")).resolves.toBe(rootRaw);
      if (["standalone", "update", "environment-rotation"].includes(scenario)) {
        if (scenario === "environment-rotation") {
          expect(saved.gateway.auth.token).toBe("${ROOT_VALUE}");
        }
        const recovered = JSON.parse(await fs.readFile(leaf, "utf8"));
        expect(recovered.entries).toEqual({
          "openclaw-qqbot": { enabled: false, config: { token: "${RECOVERY_VALUE}" } },
        });
        expect(recovered.allow).toEqual(["openclaw-qqbot"]);
        expect(recovered.deny).toEqual(["openclaw-qqbot"]);
        await expect(fs.readFile(leaf + ".bak", "utf8")).resolves.toBe(leafRaw);
        expect(ctx.configResultWriteCommitted).toBe(true);
        expect(ctx.configResult.confirmedConfigSource?.hash).toBe(
          (await configModule.readConfigFileSnapshot()).hash,
        );
      } else {
        expect(ctx.configResultWriteCommitted).not.toBe(true);
        expect(ctx.configResult.confirmedConfigSource?.hash).toBe(firstCommit?.persistedHash);
        await expect(fs.readFile(leaf, "utf8")).resolves.toBe(
          leafRaw + (scenario === "include-drift" ? "\n" : ""),
        );
        await expect(fs.stat(leaf + ".bak")).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});

it("persists the early disabled alias after Doctor repairs the same owner", async () => {
  const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
  const { runInitialConfigWriteHealth } =
    await import("../../../flows/doctor-health-contribution-runners.config.js");
  const installRepair = await import("./missing-configured-plugin-install.js");
  await withOpenClawTestState(
    { label: "doctor-recovery-repair", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const cfg = {
        gateway: { mode: "local" as const },
        plugins: { enabled: false, entries: { qqbot: { enabled: false } } },
      };
      await state.writeConfig(cfg);
      const initialOwner = await seedRecoveryOwner(state, cfg, { version: "2.0.1" });
      let repairRan = false;
      vi.spyOn(installRepair, "repairMissingConfiguredPluginInstalls").mockImplementation(
        async ({ cfg: candidate }) => {
          if (!candidate.plugins?.entries?.["openclaw-qqbot"]) {
            return {
              records: initialOwner.records,
              changes: [],
              warnings: [],
              repairedPluginIds: [],
            };
          }
          repairRan = true;
          expect(candidate.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(false);
          const owner = await seedRecoveryOwner(state, candidate, { version: "2.0.3" });
          return {
            records: owner.records,
            changes: [],
            warnings: [],
            repairedPluginIds: ["openclaw-qqbot"],
            pluginInventoryChanged: true,
          };
        },
      );
      const ctx = await prepareDoctorContext(state.configPath);
      expect(repairRan).toBe(true);
      await runInitialConfigWriteHealth(ctx);
      const saved = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(saved.plugins.entries).toEqual({ "openclaw-qqbot": { enabled: false } });
      expect(ctx.configResultWriteCommitted).toBe(true);
    },
  );
});
