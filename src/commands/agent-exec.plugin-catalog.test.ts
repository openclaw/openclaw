// `agent exec` keeps cached-only model metadata across an isolated task state.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
  type PersistedPluginModelCatalog,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { agentExecCommand } from "./agent-exec.js";

const AGENT_ID = "fixture-agent";
const tempRoots: string[] = [];

/** Creates a conventional `<state>/agents/<id>/agent` directory, as a real run does. */
function createAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-agent-exec-catalog-"));
  tempRoots.push(root);
  const agentDir = join(root, "agents", AGENT_ID, "agent");
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

/** One provider-owned generated catalog whose model the static manifest lacks. */
function seedOperatorCatalog(agentDir: string): void {
  replacePersistedPluginModelCatalogs({
    agentDir,
    pluginCatalogWrites: {
      [encodePluginModelCatalogRelativePath("catalog-owner")]: JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://fixture.example/v1",
            apiKey: "operator-api-key",
            models: [{ id: "cached-only-model", name: "Cached only", contextWindow: 65536 }],
          },
        },
      }),
    },
  });
}

function baseConfig(agentDir: string): OpenClawConfig {
  return { agents: { entries: { [AGENT_ID]: { agentDir } } } };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agent exec cached-only model metadata", () => {
  it("preserves validated operator catalog metadata for a fresh task state", async () => {
    const operatorDir = createAgentDir();
    seedOperatorCatalog(operatorDir);
    // A directory this run does not own: only the handoff can fill it.
    const independentDir = createAgentDir();
    let observed: readonly PersistedPluginModelCatalog[] = [];
    const runAgent = vi.fn(async () => {
      observed = loadPersistedPluginModelCatalogsReadOnly(independentDir);
      return { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
    });

    const result = await agentExecCommand("inspect", {}, createRuntime(), {
      agentId: AGENT_ID,
      baseConfig: baseConfig(operatorDir),
      runAgent,
    });

    expect(result.envelope.error?.message).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(observed.map((catalog) => catalog.pluginId)).toEqual(["catalog-owner"]);
    expect(observed[0]?.contents).toContain("cached-only-model");
    // Credentials stay in the operator's own cache.
    expect(observed[0]?.contents).not.toContain("operator-api-key");
  });

  it("carries no operator catalog metadata for environment-only exec", async () => {
    const operatorDir = createAgentDir();
    seedOperatorCatalog(operatorDir);
    const independentDir = createAgentDir();
    let observed: readonly PersistedPluginModelCatalog[] = [];
    const runAgent = vi.fn(async () => {
      observed = loadPersistedPluginModelCatalogsReadOnly(independentDir);
      return { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
    });

    const result = await agentExecCommand("inspect", { authEnvOnly: true }, createRuntime(), {
      agentId: AGENT_ID,
      baseConfig: baseConfig(operatorDir),
      runAgent,
    });

    expect(result.envelope.error?.message).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(observed).toEqual([]);
  });
});
