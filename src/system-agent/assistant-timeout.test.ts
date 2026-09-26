// System-agent timeout tests cover manifest-owned local-route classification.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  SYSTEM_AGENT_ASSISTANT_LOCAL_TIMEOUT_MS,
  SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS,
} from "./assistant-prompts.js";
import { resolveSystemAgentAssistantTimeoutMs } from "./assistant-timeout.js";

describe("system-agent assistant timeout", () => {
  it.each([
    {
      name: "local provider",
      provider: "ollama",
      modelLabel: "ollama/qwen3.5:4b",
      external: false,
      expected: SYSTEM_AGENT_ASSISTANT_LOCAL_TIMEOUT_MS,
    },
    {
      name: "hosted sibling provider",
      provider: "ollama-cloud",
      modelLabel: "ollama-cloud/glm-5.2:cloud",
      external: true,
      expected: SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS,
    },
  ])("uses the $name budget", ({ provider, modelLabel, external, expected }) => {
    const workspaceDir = path.resolve("timeout-workspace");
    const config = { agents: { entries: { main: { workspace: workspaceDir } } } };
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "timeout-fixture", modelPricing: { providers: { [provider]: { external } } } },
      ],
    });
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(snapshot);
    try {
      expect(
        resolveSystemAgentAssistantTimeoutMs({
          sourceConfig: config,
          runConfig: config,
          modelLabel,
          provider,
          model: modelLabel.split("/").slice(1).join("/"),
          agentDir: path.join(workspaceDir, "agent"),
          agentId: "main",
          runner: "embedded",
        }),
      ).toBe(expected);
      expect(resolveMetadata).toHaveBeenCalledExactlyOnceWith({
        config,
        workspaceDir,
        env: process.env,
        allowWorkspaceScopedCurrent: true,
      });
    } finally {
      resolveMetadata.mockRestore();
    }
  });
});
