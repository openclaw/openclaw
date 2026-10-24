import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readConfigFileSnapshot } from "../../../config/config.js";
import { createConfigIO } from "../../../config/io.factory.js";
import {
  collectEnvSecretRefIds,
  createConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "../../../config/resolution-facts.js";
import { writeOpenClawConfig } from "../../../config/test-helpers.js";
import type { ConfigFileSnapshot } from "../../../config/types.js";
import { recordDeferredPluginMigrations } from "../../../infra/deferred-plugin-migrations.js";
import { isPathInside } from "../../../infra/path-guards.js";
import * as pluginModuleLoader from "../../../plugins/plugin-module-loader-cache.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { withDoctorConfigPreflightHome } from "../../doctor-config-preflight.test-support.js";
import { createTestConfigSnapshot } from "../../test-runtime-config-helpers.js";
import {
  commitAutomaticConfigRepair,
  planAutomaticConfigRepair,
  resolveLegacyConfigSnapshotForBackup,
} from "./automatic-config-repair.js";

function invalidSnapshot(
  config: Record<string, unknown>,
  issuePaths: string[] = [],
  includedPaths: string[] = [],
): ConfigFileSnapshot {
  return {
    ...createTestConfigSnapshot(config),
    includedPaths,
    raw: JSON.stringify(config),
    parsed: config,
    valid: false,
    issues: issuePaths.map((issuePath) => ({ path: issuePath, message: "retired" })),
    legacyIssues: [{ path: "", message: "retired" }],
  };
}

function idleConfig(extra: Record<string, unknown> = {}) {
  return { session: { idleMinutes: 45 }, ...extra };
}

async function writeFixture(home: string, config: Record<string, unknown>, pretty = false) {
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw", "openclaw.json");
  const raw = pretty ? `${JSON.stringify(config, null, 2)}\n` : JSON.stringify(config);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, raw);
  return { configPath, raw };
}

function readFixture(
  configPath: string,
  options: Omit<NonNullable<Parameters<typeof createConfigIO>[0]>, "configPath" | "observe"> = {},
) {
  return createConfigIO({
    configPath,
    env: process.env,
    ...options,
    observe: false,
  }).readConfigFileSnapshot();
}

const legacyPluginInput = { root: "/srv/pending-plugin-state" };
const pendingPlugin = { allow: ["pending-owner"], entries: { "pending-owner": { enabled: true } } };
const pending = {
  pluginId: "pending-owner",
  reason: "The configured plugin is not installed.",
  command: "openclaw update repair",
  configPaths: [["legacyPluginInput"]],
  validationExcludedPaths: [["legacyPluginInput"]],
};

describe("automatic config repair", () => {
  it("preserves a resolved legacy channel owner in the same repair as the explicit roster", async () => {
    const coreSourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const loadModule = pluginModuleLoader.getCachedPluginModuleLoader;
    const nativeRepair = vi
      .spyOn(pluginModuleLoader, "getCachedPluginModuleLoader")
      .mockImplementation((options) => {
        if (isPathInside(coreSourceRoot, options.modulePath)) {
          throw new Error("Host core must retain its native module graph during binding repair");
        }
        return loadModule(options);
      });
    onTestFinished(() => nativeRepair.mockRestore());
    await withOpenClawTestState({ prefix: "openclaw-channel-owner-repair-" }, async (state) => {
      await state.writeConfig({
        agents: { list: [{ id: "${LEGACY_CHANNEL_AGENT}" }, { id: "main" }] },
        channels: { telegram: { botToken: "123456:synthetic-owner" } },
        bindings: [
          { agentId: "main", match: { channel: "telegram", peer: { kind: "direct", id: "123" } } },
        ],
      });
      const snapshot = await readFixture(state.configPath, {
        env: { ...state.env, LEGACY_CHANNEL_AGENT: "ops" },
      });
      expect(snapshot.valid).toBe(false);
      const plan = await planAutomaticConfigRepair(snapshot);
      expect(plan?.snapshot.valid).toBe(true);
      expect(plan?.config.agents?.ownership).toBe("explicit");
      expect(plan?.config.bindings).toContainEqual({
        agentId: "ops",
        match: { channel: "telegram", accountId: "default" },
      });
      expect(plan?.changes.join("\n")).toContain("Preserved telegram:default ownership");
    });
  });

  it.each([
    { providerId: "partner.east", refPath: 'models.providers["partner.east"].apiKey' },
    { providerId: "42", refPath: 'models.providers["42"].apiKey' },
  ])(
    "preserves real-reader env provenance for quoted provider $providerId during repair",
    async ({ providerId, refPath }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const { configPath, raw } = await writeFixture(home, {
          gateway: { mode: "local" },
          session: { idleMinutes: 45 },
          models: {
            providers: {
              [providerId]: {
                baseUrl: "https://provider.invalid/v1",
                api: "openai-completions",
                apiKey: "${QUOTED_REPAIR_KEY}",
                models: [{ id: "fixture-model", name: "Fixture model" }],
              },
            },
          },
        });
        const snapshot = await readFixture(configPath, {
          env: { ...process.env, QUOTED_REPAIR_KEY: "synthetic-environment-file-value" },
        });
        expect(snapshot.valid).toBe(false);
        expect(snapshot.sourceConfig.session).toHaveProperty("idleMinutes", 45);
        expect(snapshot.sourceConfig.models?.providers?.[providerId]?.apiKey).toBe(
          "synthetic-environment-file-value",
        );
        expect(getResolvedConfigEnvSecretRef(snapshot.sourceConfig, refPath)?.id).toBe(
          "QUOTED_REPAIR_KEY",
        );

        const repaired = await resolveLegacyConfigSnapshotForBackup(snapshot);
        expect(repaired?.valid).toBe(true);
        expect(repaired?.sourceConfig.session?.reset?.idleMinutes).toBe(45);
        expect(collectEnvSecretRefIds(repaired?.sourceConfig)).toEqual(
          new Set(["QUOTED_REPAIR_KEY"]),
        );
        expect(getResolvedConfigEnvSecretRef(repaired?.sourceConfig, refPath)?.id).toBe(
          "QUOTED_REPAIR_KEY",
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      });
    },
  );

  it.each(["deferred", "unavailable", "commit"])(
    "preserves plugin inputs during core repair (%s)",
    async (availability) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const deferred = availability !== "unavailable";
        const missingPath = path.join(home, "nonexistent-startup-plugin");
        const plugins = deferred ? pendingPlugin : { load: { paths: [missingPath] } };
        const source = deferred
          ? {
              gateway: { mode: "local" },
              tools: { exec: { timeoutSec: 45 } },
              plugins,
              legacyPluginInput,
            }
          : { session: { idleMinutes: 45 }, plugins };
        const { configPath, raw } = await writeFixture(home, source, true);
        if (availability === "commit") {
          // The write must publish against the recorded deferral generation.
          await recordDeferredPluginMigrations({ env: process.env, pending: [pending] });
        }
        const snapshot = await readFixture(
          configPath,
          deferred ? { deferredPluginMigrations: [pending] } : {},
        );
        expect(snapshot.valid).toBe(false);
        const plan = await planAutomaticConfigRepair(snapshot);
        if (!plan) {
          throw new Error("expected a repairable plugin config");
        }
        expect(plan?.snapshot.valid).toBe(true);
        if (deferred) {
          expect(snapshot.issues.some((issue) => issue.path.startsWith("tools.exec"))).toBe(true);
          expect(plan?.config.tools?.exec?.timeoutSeconds).toBe(45);
          expect(plan?.config).not.toHaveProperty("tools.exec.timeoutSec");
          expect(plan?.config).toHaveProperty("legacyPluginInput", legacyPluginInput);
          expect(plan?.snapshot.sourceConfig).toHaveProperty(
            "legacyPluginInput",
            legacyPluginInput,
          );
          expect(plan?.snapshot.runtimeConfig).not.toHaveProperty("legacyPluginInput");
          expect(snapshot.sourceConfig).toHaveProperty("tools.exec.timeoutSec", 45);
        } else {
          expect(plan?.config.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
          expect(plan?.config.plugins).toEqual(plugins);
          expect(plan?.snapshot.warnings).toContainEqual(
            expect.objectContaining({
              code: "configured-plugin-path-unavailable",
              path: "plugins.load.paths",
              source: missingPath,
            }),
          );
          expect(snapshot.sourceConfig.session).toEqual({ idleMinutes: 45 });
        }
        if (availability === "commit") {
          await commitAutomaticConfigRepair(plan, snapshot);
          const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
          expect(saved.tools.exec).toEqual({ timeoutSeconds: 45 });
          expect(saved.legacyPluginInput).toEqual(legacyPluginInput);
        } else {
          expect(await fs.readFile(configPath, "utf8")).toBe(raw);
        }
      });
    },
  );

  it.each([
    {
      name: "browser reference when the environment rotates before commit",
      config: { browser: { executablePath: "${BROWSER_BIN}" }, session: { idleMinutes: 45 } },
      env: { BROWSER_BIN: "/opt/example/browser-planning" },
      commitEnv: { BROWSER_BIN: "/opt/example/browser-current" },
      outputPath: "browser.executablePath",
      authored: "${BROWSER_BIN}",
      resolved: "/opt/example/browser-current",
      allowCollaborativeSteering: false,
    },
    ...[
      { apiKey: "${STARTUP_MEMORY_KEY}", allowCollaborativeSteering: false },
      { apiKey: "$${STARTUP_MEMORY_KEY}", allowCollaborativeSteering: true },
    ].map(({ apiKey, allowCollaborativeSteering }) => ({
      name: `moved ${apiKey} reference and explicit steering ${allowCollaborativeSteering}`,
      config: {
        agents: { defaults: { memorySearch: { remote: { apiKey } } } },
        messages: { queue: { allowCollaborativeSteering } },
      },
      env: { STARTUP_MEMORY_KEY: "fixture-memory-key" },
      commitEnv: {},
      outputPath: "memory.search.remote.apiKey",
      authored: apiKey,
      resolved: apiKey.startsWith("$$") ? "${STARTUP_MEMORY_KEY}" : "fixture-memory-key",
      allowCollaborativeSteering,
    })),
  ])("preserves $name through Doctor repair", async (testCase) => {
    await withDoctorConfigPreflightHome((home) =>
      withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", ...testCase.env }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          ...testCase.config,
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const originalBytes = await fs.readFile(configPath, "utf8");
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(false);
        expect((await resolveLegacyConfigSnapshotForBackup(snapshot))?.valid).toBe(true);
        const plan = await planAutomaticConfigRepair(snapshot);
        if (!plan) {
          throw new Error("expected a repairable reference config");
        }
        await withEnvAsync(testCase.commitEnv, async () => {
          await commitAutomaticConfigRepair(plan, snapshot);
          const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
          expect(saved).toHaveProperty(testCase.outputPath, testCase.authored);
          expect(saved.messages.queue.allowCollaborativeSteering).toBe(
            testCase.allowCollaborativeSteering,
          );
          const reloaded = await readConfigFileSnapshot();
          expect(reloaded.valid).toBe(true);
          expect(reloaded.sourceConfig).toHaveProperty(testCase.outputPath, testCase.resolved);
          expect(await planAutomaticConfigRepair(reloaded)).toBeNull();
        });
        await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(originalBytes);
      }),
    );
  });

  it("plans a config whose only migration is plugin-owned after state admission", async () => {
    // Doctor's full planner owns plugin contracts; backup projection uses core-only selection.
    const snapshot = invalidSnapshot(
      { plugins: { entries: { "active-memory": { config: { qmd: { enabled: true } } } } } },
      ["plugins.entries.active-memory.config.qmd"],
    );

    const resolved = (await planAutomaticConfigRepair(snapshot))?.snapshot;

    expect(resolved?.valid).toBe(true);
    expect(resolved?.sourceConfig.plugins?.entries?.["active-memory"]?.config).toEqual({});
  });

  it("projects legacy backup roots without touching the shared state database", async () => {
    // Backup discovery resolves before state-database admission;
    // a broken store (here: a directory at the canonical path) must not break the preview.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-repair-preview-"));
    try {
      await fs.mkdir(path.join(root, "state", "openclaw.sqlite"), { recursive: true });
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const snapshot = invalidSnapshot(
          {
            session: { idleMinutes: 45 },
            meta: { lastTouchedAt: "2026-02-15T00:00:00.000Z" },
            agents: { list: [{ id: "work", name: "Operator" }] },
          },
          ["session.idleMinutes"],
        );
        const resolved = await resolveLegacyConfigSnapshotForBackup(snapshot);
        expect(resolved?.valid).toBe(true);
        expect(resolved?.sourceConfig.session).toEqual({
          reset: { mode: "idle", idleMinutes: 45 },
        });
        expect(resolved?.sourceConfig).not.toHaveProperty("meta.lastTouchedAt");
        expect(resolved?.sourceConfig.agents?.entries?.work).toEqual({ name: "Operator" });
        expect(resolved?.sourceConfig.messages?.queue?.allowCollaborativeSteering).toBeUndefined();
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retires a reference fact whose path the repair moved", async () => {
    // The repair relocates session.idleMinutes, so a fact recorded at the authored path would
    // otherwise keep answering lookups for a value that no longer lives there.
    const config = { session: { idleMinutes: 45 } };
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["session.idleMinutes", "MOVED_KEY"]]),
      ),
    );
    const snapshot = invalidSnapshot(config, ["session.idleMinutes"]);

    const resolved = await resolveLegacyConfigSnapshotForBackup(snapshot);

    expect(resolved?.sourceConfig.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
    expect(getResolvedConfigEnvSecretRef(resolved?.sourceConfig, "session.idleMinutes")).toBeNull();
    // The read-only projection preserves the authored snapshot and its reference facts.
    expect(collectEnvSecretRefIds(snapshot.sourceConfig)).toEqual(new Set(["MOVED_KEY"]));
  });

  it.each<[string, Record<string, unknown>, string[]?]>([
    ["a non-legacy type error", { gateway: { port: "not-a-number" } }],
    [
      "ambiguous legacy default owners",
      idleConfig({ agents: { entries: { main: { default: true }, ops: { default: true } } } }),
    ],
    ["a migration with a remaining type error", idleConfig({ gateway: { port: "not-a-number" } })],
    ["an included config source", idleConfig(), ["/tmp/included.json"]],
    [
      "an include directive without recorded include paths",
      idleConfig({ $include: "included.json" }),
    ],
    [
      "a malformed plugin entry",
      idleConfig({ plugins: { entries: { broken: { enabled: "not-a-boolean" } } } }),
    ],
    [
      "malformed retired plugin records",
      { plugins: { installs: { broken: { source: "invalid" } } } },
    ],
    [
      "another invalid key at a retired key's schema parent",
      { meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z", unrelatedRetiredKey: true } },
    ],
  ])("refuses %s", async (_name, config, includedPaths) => {
    const snapshot = invalidSnapshot(config, [], includedPaths);
    expect(await planAutomaticConfigRepair(snapshot)).toBeNull();
    if (config.plugins && typeof config.plugins === "object" && "installs" in config.plugins) {
      expect(await resolveLegacyConfigSnapshotForBackup(snapshot)).toBeUndefined();
    }
  });
});
