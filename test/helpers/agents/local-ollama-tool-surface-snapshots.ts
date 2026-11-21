import path from "node:path";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../../src/agents/harness/tool-surface-bridge.js";
import { createStubTool } from "../../../src/agents/test-helpers/agent-tool-stubs.js";
import { LOCAL_OLLAMA_PROMPT_SNAPSHOT_DIR } from "./prompt-snapshot-paths.js";

/** Snapshot the native surface with lightweight schemas; live proofs measure provider token cost. */
export function createLocalOllamaToolSurfaceSnapshotFiles() {
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config: {},
    model: { api: "ollama", toolSearchMode: "tools", contextWindow: 32_768 },
    modelToolsEnabled: true,
    preparedToolOverrideAllowlist: [],
  });
  try {
    const surface = runtime.compactTools(
      ["web_search", "web_fetch", "memory_search", "memory_get", "sessions_list"].map(
        createStubTool,
      ),
    );
    const prompt = surface.promptToolPolicy.apply();
    return [
      {
        path: path.join(LOCAL_OLLAMA_PROMPT_SNAPSHOT_DIR, "default-tool-surface.json"),
        content: `${JSON.stringify(
          {
            scope:
              "Native local Ollama with tools.toolSearch unset; fixture schemas, not provider wire payloads",
            tools: prompt.tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
            toolSchemaDirectoryPrompt: prompt.toolSchemaDirectoryPrompt,
          },
          null,
          2,
        )}\n`,
      },
    ];
  } finally {
    runtime.cleanup();
  }
}
