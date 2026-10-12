// `agent exec` keeps cached-only model metadata across an isolated task state.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
  type PersistedPluginModelCatalog,
} from "../agents/plugin-model-catalog.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { runAgentExecWithMock } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

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

function successResult(text = "done") {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: "session-result",
        provider: "openai",
        model: "gpt-5.6-sol",
        usage: { input: 10, output: 2, total: 12 },
      },
    },
  };
}

/** One provider-owned generated catalog whose model the static manifest lacks. */
async function seedOperatorCatalog(agentDir: string): Promise<void> {
  await replacePersistedPluginModelCatalogs({
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

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agent exec cached-only model metadata", () => {
  it("preserves validated operator catalog metadata for a fresh task state", async () => {
    const operatorDir = createAgentDir();
    await seedOperatorCatalog(operatorDir);
    // A directory this run does not own: only the handoff can fill it.
    const independentDir = createAgentDir();
    let observed: readonly PersistedPluginModelCatalog[] = [];
    setRuntimeConfigSnapshot(baseConfig(operatorDir));

    const result = await runAgentExecWithMock("inspect", {}, createTestRuntime(), async () => {
      observed = loadPersistedPluginModelCatalogsReadOnly(independentDir);
      return successResult();
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
    await seedOperatorCatalog(operatorDir);
    const independentDir = createAgentDir();
    let observed: readonly PersistedPluginModelCatalog[] = [];
    setRuntimeConfigSnapshot(baseConfig(operatorDir));

    const result = await runAgentExecWithMock(
      "inspect",
      { authEnvOnly: true },
      createTestRuntime(),
      async () => {
        observed = loadPersistedPluginModelCatalogsReadOnly(independentDir);
        return successResult();
      },
    );

    expect(result.envelope.error?.message).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(observed).toEqual([]);
  });
});
