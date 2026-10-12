import fs from "node:fs/promises";
import { vi } from "vitest";
import * as cliRunner from "../agents/cli-runner.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import * as assistantTimeout from "./assistant-timeout.js";
import { planSystemAgentCommand as planSystemAgentCommandImpl } from "./assistant.js";
import type { SystemAgentVerifiedInferenceDeps } from "./verified-inference.js";

// mock-isolation: Planner dispatch fixtures never initialize or launch a CLI runner.
vi.mock("../agents/cli-runner.js", () => ({ runCliAgent: vi.fn() }));
// mock-isolation: Planner dispatch fixtures never initialize the embedded agent runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

type PlannerTestDeps = SystemAgentVerifiedInferenceDeps & {
  runCliAgent?: typeof cliRunner.runCliAgent;
  runEmbeddedAgent?: typeof embeddedAgent.runEmbeddedAgent;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
  resolveAssistantTimeoutMs?: typeof assistantTimeout.resolveSystemAgentAssistantTimeoutMs;
};

export async function planSystemAgentCommand(
  params: Omit<Parameters<typeof planSystemAgentCommandImpl>[0], "deps"> & {
    deps?: PlannerTestDeps;
  },
) {
  const {
    runCliAgent,
    runEmbeddedAgent,
    createTempDir,
    removeTempDir,
    resolveAssistantTimeoutMs,
    ...routeDeps
  } = params.deps ?? {};
  const mocks: Array<{ mockRestore(): void }> = [];
  try {
    if (runCliAgent) {
      mocks.push(vi.spyOn(cliRunner, "runCliAgent").mockImplementation(runCliAgent));
    }
    if (runEmbeddedAgent) {
      mocks.push(vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent));
    }
    if (createTempDir) {
      mocks.push(vi.spyOn(fs, "mkdtemp").mockImplementation(createTempDir));
    }
    if (removeTempDir) {
      mocks.push(vi.spyOn(fs, "rm").mockImplementation((dir) => removeTempDir(String(dir))));
    }
    if (resolveAssistantTimeoutMs) {
      mocks.push(
        vi
          .spyOn(assistantTimeout, "resolveSystemAgentAssistantTimeoutMs")
          .mockImplementation(resolveAssistantTimeoutMs),
      );
    }
    return await planSystemAgentCommandImpl({ ...params, deps: routeDeps });
  } finally {
    for (const mock of mocks.toReversed()) {
      mock.mockRestore();
    }
  }
}
