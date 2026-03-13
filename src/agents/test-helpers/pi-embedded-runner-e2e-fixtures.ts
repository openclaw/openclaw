import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";

export type EmbeddedPiRunnerTestWorkspace = {
  tempRoot: string;
  agentDir: string;
  workspaceDir: string;
};

export async function createEmbeddedPiRunnerTestWorkspace(
  prefix: string,
): Promise<EmbeddedPiRunnerTestWorkspace> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(tempRoot, "agent");
  const workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  return { tempRoot, agentDir, workspaceDir };
}

export async function cleanupEmbeddedPiRunnerTestWorkspace(
  workspace: EmbeddedPiRunnerTestWorkspace | undefined,
): Promise<void> {
  if (!workspace) {
    return;
  }
  await fs.rm(workspace.tempRoot, { recursive: true, force: true });
}

export function createEmbeddedPiRunnerOpenAiConfig(modelIds: string[]): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  };
}

export async function immediateEnqueue<T>(task: () => Promise<T>): Promise<T> {
  return await task();
}
