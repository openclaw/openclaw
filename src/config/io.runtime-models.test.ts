import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetModelsJsonReadyCacheForTest } from "../agents/models-config-state.test-support.js";
import { CUSTOM_PROXY_MODELS_CONFIG } from "../agents/models-config.e2e-harness.js";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "../agents/models-config.js";
import { persistClawInstallRecord } from "../claws/provenance.js";
import { makeProvenancePlan } from "../claws/provenance.test-helpers.js";
import { resolveClawToolPolicyConsent } from "../claws/tool-policy-runtime.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    clearRuntimeConfigSnapshot();
    resetModelsJsonReadyCacheForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

async function fixture() {
  const home = dirs.make("models-cold-runtime-");
  const state = path.join(home, "state");
  const bundled = path.join(home, "bundled");
  await fs.mkdir(bundled);
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_AGENT_DIR: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
    OPENCLAW_LOAD_SHELL_ENV: undefined,
  })) {
    vi.stubEnv(key, value);
  }
  const { plan } = await makeProvenancePlan(
    home,
    { schemaVersion: 1, agent: { id: "worker" } },
    { openClawProfile: { schemaVersion: 1, agent: { tools: { allow: ["read"] } } } },
  );
  persistClawInstallRecord(plan, { env: process.env });
  const { id, ...agent } = plan.agent.config;
  const config = {
    ...CUSTOM_PROXY_MODELS_CONFIG,
    agents: { entries: { [id]: agent } },
  };
  await fs.writeFile(path.join(state, "openclaw.json"), JSON.stringify(config));
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
  const agentDir = path.join(state, "agents", "worker", "agent");
  return { config, agentDir, state };
}

it.each(["ensure", "plan"] as const)(
  "%s loads cold config and Claw consent without host provenance SQL",
  async (operation) => {
    const { agentDir } = await fixture();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const contents = await withPluginCache(createPluginCache(), async () => {
      if (operation === "plan") {
        return (await planOpenClawModelsJsonSource(undefined, agentDir)).modelsJsonContents;
      }
      await ensureOpenClawModelsJson(undefined, agentDir);
      return fs.readFile(path.join(agentDir, "models.json"), "utf8");
    });
    expect(JSON.parse(contents ?? "null")).toEqual({
      providers: CUSTOM_PROXY_MODELS_CONFIG.models?.providers,
    });
    const tools = getRuntimeConfigSnapshot()?.agents?.entries?.worker?.tools;
    expect(
      resolveClawToolPolicyConsent({
        agentTools: tools,
        agentId: "worker",
        hasAgentAllowlist: true,
        ownsProfile: true,
        profile: "full",
      }),
    ).toEqual({ frozen: true });
    const hostQueries = prepare.mock.calls.map(([sql]) => sql);
    expect(hostQueries.filter((sql) => /from\s+"?claw_installs/i.test(sql))).toEqual([]);
  },
);

it("keeps source secret markers when the same runtime is republished before continuation", async () => {
  const { config, agentDir } = await fixture();
  const provider = CUSTOM_PROXY_MODELS_CONFIG.models!.providers!["custom-proxy"]!;
  const sourceFor = (id: string) => ({
    ...config,
    models: {
      providers: {
        "custom-proxy": {
          ...provider,
          apiKey: { source: "env" as const, provider: "default", id },
        },
      },
    },
  });
  setRuntimeConfigSnapshot(config, sourceFor("MODEL_ORIGINAL_KEY"));
  const pending = ensureOpenClawModelsJson(undefined, agentDir);
  setRuntimeConfigSnapshot(config, sourceFor("MODEL_REPLACEMENT_KEY"));
  await pending;
  const contents = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
  expect(JSON.parse(contents ?? "null").providers["custom-proxy"].apiKey).toBe(
    "MODEL_ORIGINAL_KEY",
  );
});

it.each(["cold selector", "pinned directory"] as const)(
  "retains captured model-config authority after an environment change: %s",
  async (mode) => {
    const { config, agentDir, state } = await fixture();
    if (mode === "pinned directory") {
      setRuntimeConfigSnapshot(config);
    }
    const pending = ensureOpenClawModelsJson(
      undefined,
      mode === "cold selector" ? agentDir : undefined,
    );
    vi.stubEnv(
      mode === "cold selector" ? "OPENCLAW_CONFIG_PATH" : "OPENCLAW_STATE_DIR",
      path.join(state, mode === "cold selector" ? "replaced.json" : "replacement-state"),
    );
    if (mode === "pinned directory") {
      expect((await pending).agentDir).toBe(agentDir);
    } else {
      await expect(pending).rejects.toThrow("Runtime config source changed");
      expect(getRuntimeConfigSnapshot()).toBeNull();
      await expect(fs.access(path.join(agentDir, "models.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
);
