import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../agents/config.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
} from "../plugins/doctor-contract-module.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { detectLegacyStateMigrations } from "./state-migrations.doctor.js";
import { migrateLegacyAgentDir } from "./state-migrations.legacy-sessions.js";
import {
  createLegacyStateMigrationStepReceipt,
  throwIfDoctorStateMigrationRefused,
} from "./state-migrations.messages.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import { runLegacyMigrationPlans } from "./state-migrations.plugin-state.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { migrateLegacyUpdateCheckState } from "./state-migrations.update-check.js";

function migrationReceipt(id: string, result: MigrationMessages) {
  return createLegacyStateMigrationStepReceipt(
    {
      id,
      phase: "shared",
      source: [],
      target: [],
      requiredness: "required",
      reversibility: "checkpoint-required",
    },
    result,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
});

describe("recoverable legacy state", () => {
  it.each([
    { failure: "malformed", canonical: true },
    { failure: "unreadable", canonical: true },
    { failure: "malformed", canonical: false },
    { failure: "unreadable", canonical: false },
  ])(
    "keeps $failure update metadata advisory only with canonical state=$canonical",
    async ({ failure, canonical }) => {
      await withOpenClawTestState({ label: "update-check-recovery" }, async ({ stateDir, env }) => {
        const sourcePath = path.join(stateDir, "update-check.json");
        const sourceBytes = failure === "malformed" ? "{invalid legacy JSON" : "{}";
        await fs.writeFile(sourcePath, sourceBytes);
        const canonicalState = {
          autoInstallId: "canonical-install",
          autoFirstSeenVersion: "2026.9.3",
          autoFirstSeenAt: "2026-09-08T00:00:00.000Z",
          autoLastAttemptVersion: "2026.9.3",
          autoLastAttemptAt: "2026-09-08T01:00:00.000Z",
        };
        if (canonical) {
          writeConfigMachineState("update.checkState", canonicalState, { env });
        }
        if (failure === "unreadable") {
          const readFile = fsSync.readFileSync;
          vi.spyOn(fsSync, "readFileSync").mockImplementation((target, options) => {
            if (target === sourcePath) {
              throw new Error("synthetic legacy cache permission denied");
            }
            return readFile(target, options);
          });
        }

        const result = migrateLegacyUpdateCheckState({
          stateDir,
          detected: { sourcePath, hasLegacy: true },
        });
        const receipt = migrationReceipt("update-check", result);

        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(sourceBytes);
        expect(readConfigMachineState("update.checkState", { env })).toEqual(
          canonical ? canonicalState : undefined,
        );
        expect(receipt.warnings.join("\n")).toContain("update-check");
        if (canonical) {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
          expect(receipt.outcome).toBe("warning");
          expect(receipt.warnings.join("\n")).toContain("openclaw doctor --fix");
        } else {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
            "Doctor stopped because a state migration refused",
          );
          expect(receipt.outcome).toBe("refused");
        }
        vi.restoreAllMocks();
      });
    },
  );

  it.each([false, true])(
    "keeps Discord cache cleanup advisory unless another import fails (%s)",
    async (failedImport) => {
      await withOpenClawTestState({ label: "discord-cache-cleanup" }, async ({ stateDir, env }) => {
        const discordDir = path.join(stateDir, "discord");
        const sourcePath = path.join(discordDir, "command-deploy-cache.json");
        await fs.mkdir(discordDir, { recursive: true });
        await fs.writeFile(sourcePath, "retired deploy hashes");
        if (failedImport) {
          await fs.writeFile(path.join(discordDir, "thread-bindings.json"), "{}");
        }
        const unlink = fsSync.unlinkSync;
        vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
          if (target === sourcePath) {
            throw new Error("synthetic cache cleanup permission denied");
          }
          unlink(target);
        });
        const { stateMigrations } = coercePluginDoctorContractModule(
          await vi.importActual<PluginDoctorContractModule>(
            path.resolve("extensions/discord/doctor-contract-api.ts"),
          ),
        );
        const migration = expectDefined(stateMigrations?.[0], "Discord Doctor migration");
        const params = {
          config: {},
          env,
          stateDir,
          oauthDir: path.join(stateDir, "credentials"),
          context: createPluginDoctorStateMigrationContext({
            pluginId: "discord",
            env,
            config: {},
          }),
        };

        const result = await migration.migrateLegacyState(params);
        const receipt = migrationReceipt(migration.id, result);

        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("retired deploy hashes");
        expect(receipt.warnings.join("\n")).toContain("Discord command deployment cache");
        expect(receipt.warnings.join("\n")).toContain("synthetic cache cleanup permission denied");
        if (failedImport) {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
            "Doctor stopped because a state migration refused",
          );
          expect(receipt.warnings.join("\n")).toContain("legacy Discord thread bindings store");
        } else {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
          expect(receipt.outcome).toBe("warning");
          expect(receipt.warnings.join("\n")).toContain("openclaw doctor --fix");
        }
        vi.restoreAllMocks();
        if (!failedImport) {
          expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
          await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it("keeps a shared source blocked when another cleanup owner does not opt in", async () => {
    await withOpenClawTestState({ label: "shared-cleanup-policy" }, async ({ stateDir }) => {
      const sourcePath = path.join(stateDir, "shared-cache.json");
      await fs.writeFile(sourcePath, "retained source");
      const unlink = fsSync.unlinkSync;
      vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
        if (target === sourcePath) {
          throw new Error("synthetic shared cleanup failure");
        }
        unlink(target);
      });

      const result = await runLegacyMigrationPlans(
        ["optional", "required"].map((namespace) => ({
          kind: "plugin-state-import",
          label: `${namespace} state`,
          sourcePath,
          targetPath: `plugin state:${namespace}`,
          pluginId: "cleanup-fixture",
          namespace,
          stateDir,
          maxEntries: 10,
          scopeKey: "",
          cleanupSource: "remove",
          cleanupWhenEmpty: true,
          cleanupWarningDisposition: namespace === "optional" ? "recoverable" : undefined,
          readEntries: () => [],
        })),
      );

      const receipt = migrationReceipt("shared-cleanup", result);
      expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
        "Doctor stopped because a state migration refused",
      );
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("retained source");
      vi.restoreAllMocks();
    });
  });
});

describe("legacy agent directory migration", () => {
  it("keeps standalone state until Doctor migrates it and reports recreated legacy state", async () => {
    await withOpenClawTestState(
      { label: "standalone-agent-cutover", agentEnv: "clear" },
      async (state) => {
        await state.writeText("agent/bin/fd", "legacy binary");
        const legacyDir = state.statePath("agent");
        const canonicalDir = state.agentDir();
        const detect = () =>
          detectLegacyStateMigrations({
            cfg: { agents: { entries: { main: {} } } },
            env: state.env,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          });

        expect(getAgentDir()).toBe(legacyDir);
        await expect(fs.stat(canonicalDir)).rejects.toMatchObject({ code: "ENOENT" });
        const detected = await detect();
        expect(detected.agentDir.targetDir).toBe(canonicalDir);
        await migrateLegacyAgentDir(detected, () => 1234);
        expect(getAgentDir()).toBe(canonicalDir);
        await expect(fs.readFile(path.join(canonicalDir, "bin/fd"), "utf8")).resolves.toBe(
          "legacy binary",
        );

        await state.writeText("agent/bin/fd", "recreated binary");
        expect(getAgentDir()).toBe(canonicalDir);
        const leftover = await detect();
        expect(leftover.agentDir.hasLegacy).toBe(true);
        expect(leftover.preview).toContainEqual(expect.stringContaining(legacyDir));
        const result = await migrateLegacyAgentDir(leftover, () => 5678);
        expect(result.warningDisposition).toBe("recoverable");
        expect(result.warnings).toContainEqual(expect.stringContaining("quarantined legacy copy"));
        await expect(fs.readFile(path.join(canonicalDir, "bin/fd"), "utf8")).resolves.toBe(
          "legacy binary",
        );
        await expect(fs.stat(legacyDir)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it.each(["external", "ancestor-symlink"])(
    "keeps conflict quarantines confined to state for an %s agent directory",
    async (layout) => {
      await withOpenClawTestState({ label: "agent-quarantine-boundary" }, async (state) => {
        const outside = path.join(state.root, "external");
        const physicalTarget = path.join(outside, "agent");
        await fs.mkdir(path.join(physicalTarget, "bin"), { recursive: true });
        await fs.writeFile(path.join(physicalTarget, "bin/rg"), "current binary");
        let targetDir = physicalTarget;
        if (layout === "ancestor-symlink") {
          const alias = state.statePath("linked");
          await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
          targetDir = path.join(alias, "agent");
        }
        await state.writeText("agent/bin/rg", "legacy binary");
        await state.writeText("agent/bin/fd", "missing binary");
        const detected = await detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: { agentDir: targetDir } } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

        const result = await migrateLegacyAgentDir(detected, () => 1234);

        const quarantines = (await fs.readdir(state.stateDir)).filter((name) =>
          name.startsWith("agent.legacy-"),
        );
        expect(quarantines).toHaveLength(1);
        const stateRoot = await fs.realpath(state.stateDir);
        const quarantine = path.join(
          stateRoot,
          expectDefined(quarantines[0], "confined quarantine"),
        );
        expect(await fs.realpath(path.dirname(quarantine))).toBe(stateRoot);
        expect(await fs.realpath(quarantine)).toBe(quarantine);
        expect(
          (await fs.readdir(outside)).filter((name) => name.startsWith("agent.legacy-")),
        ).toEqual([]);
        await expect(fs.readFile(path.join(quarantine, "bin/rg"), "utf8")).resolves.toBe(
          "legacy binary",
        );
        await expect(fs.readFile(path.join(physicalTarget, "bin/rg"), "utf8")).resolves.toBe(
          "current binary",
        );
        await expect(fs.readFile(path.join(physicalTarget, "bin/fd"), "utf8")).resolves.toBe(
          "missing binary",
        );
        expect(result.warningDisposition).toBe("recoverable");
        expect(result.warnings).toEqual([expect.stringContaining(path.join(quarantine, "bin/rg"))]);
      });
    },
  );

  it.each(["custom-agent", "agent"])(
    "honors the configured agent directory %s",
    async (directory) => {
      await withOpenClawTestState({ label: "legacy-agent-configured" }, async (state) => {
        await state.writeText("agent/settings.json", "legacy settings");
        const targetDir = state.statePath(directory);
        const detected = await detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: { agentDir: targetDir } } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        expect(detected.agentDir.targetDir).toBe(targetDir);
        expect(detected.agentDir.hasLegacy).toBe(directory !== "agent");
        const result = await migrateLegacyAgentDir(detected, () => 1234);
        expect(result.warnings).toEqual([]);
        await expect(fs.readFile(path.join(targetDir, "settings.json"), "utf8")).resolves.toBe(
          "legacy settings",
        );
      });
    },
  );

  it("merges nested binaries, keeps destination bytes, and quarantines only conflicts once", async () => {
    await withOpenClawTestState({ label: "legacy-agent-merge" }, async (state) => {
      await state.writeText("agent/bin/rg", "legacy binary");
      await state.writeText("agent/bin/fd", "identical binary");
      await state.writeText("agent/bin/nested/tool", "missing tool");
      await state.writeText("agents/main/agent/bin/rg", "current binary");
      await state.writeText("agents/main/agent/bin/fd", "identical binary");
      const detect = () =>
        detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: {} } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

      const result = await migrateLegacyAgentDir(await detect(), () => 1234);

      await expect(fs.readFile(state.agentDir() + "/bin/nested/tool", "utf8")).resolves.toBe(
        "missing tool",
      );
      await expect(fs.readFile(state.agentDir() + "/bin/rg", "utf8")).resolves.toBe(
        "current binary",
      );
      await expect(fs.readFile(state.agentDir() + "/bin/fd", "utf8")).resolves.toBe(
        "identical binary",
      );
      const agentRoot = await fs.realpath(state.stateDir);
      const quarantines = (await fs.readdir(agentRoot)).filter((name) =>
        name.startsWith("agent.legacy-"),
      );
      expect(quarantines).toHaveLength(1);
      const quarantine = path.join(agentRoot, expectDefined(quarantines[0], "conflict quarantine"));
      await expect(fs.readFile(path.join(quarantine, "bin/rg"), "utf8")).resolves.toBe(
        "legacy binary",
      );
      expect(await fs.readdir(path.join(quarantine, "bin"))).toEqual(["rg"]);
      expect(result).toMatchObject({ warningDisposition: "recoverable" });
      expect(result.warnings).toEqual([expect.stringContaining(path.join(quarantine, "bin/rg"))]);
      expect(result.changes).toContainEqual(expect.stringContaining(path.join("bin", "nested")));
      await expect(fs.stat(state.statePath("agent"))).rejects.toMatchObject({ code: "ENOENT" });

      // An older binary can recreate an identical file between Doctor runs.
      await state.writeText("agent/bin/fd", "identical binary");
      const repeated = await migrateLegacyAgentDir(await detect(), () => 5678);
      expect(repeated.warnings).toEqual([]);
      expect(
        (await fs.readdir(agentRoot)).filter((name) => name.startsWith("agent.legacy-")),
      ).toEqual(quarantines);
    });
  });

  it("reports old quarantine artifacts without requiring a new legacy payload or deleting data", async () => {
    await withOpenClawTestState({ label: "legacy-agent-quarantine" }, async (state) => {
      await state.writeText("agent.legacy-1234/bin/rg", "preserved binary");
      await state.writeText("agents/main/agent.legacy-1234/bin/rg", "older layout binary");
      const detected = await detectLegacyStateMigrations({
        cfg: { agents: { entries: { main: {} } } },
        env: state.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(detected.agentDir.hasLegacy).toBe(false);
      expect(
        detected.notices?.filter((notice) => notice.includes("older than 30 days")),
      ).toHaveLength(2);
      await expect(fs.readFile(state.statePath("agent.legacy-1234/bin/rg"), "utf8")).resolves.toBe(
        "preserved binary",
      );
      await expect(
        fs.readFile(state.statePath("agents/main/agent.legacy-1234/bin/rg"), "utf8"),
      ).resolves.toBe("older layout binary");
    });
  });

  it("does not create another quarantine when an old runtime recreates identical binaries", async () => {
    await withOpenClawTestState({ label: "legacy-agent-repeat" }, async (state) => {
      await state.writeText("agent/bin/fd", "identical binary");
      await state.writeText("agents/main/agent/bin/fd", "identical binary");
      await state.writeText("agent.legacy-1234/bin/rg", "preserved binary");
      const detected = await detectLegacyStateMigrations({
        cfg: { agents: { entries: { main: {} } } },
        env: state.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      await migrateLegacyAgentDir(detected, () => 5678);
      expect(
        (await fs.readdir(state.stateDir)).filter((name) => name.startsWith("agent.legacy-")),
      ).toEqual(["agent.legacy-1234"]);
      await expect(fs.stat(state.statePath("agent"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
