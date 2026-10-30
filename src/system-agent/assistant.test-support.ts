import fs from "node:fs/promises";
import { vi } from "vitest";
import * as cliRunner from "../agents/cli-runner.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import * as config from "../config/config.js";
import { planSystemAgentCommand as planSystemAgentCommandImpl } from "./assistant.js";

// mock-isolation: Planner dispatch fixtures never initialize or launch a CLI runner.
vi.mock("../agents/cli-runner.js", () => ({ runCliAgent: vi.fn() }));
// mock-isolation: Planner dispatch fixtures never initialize the embedded agent runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

type PlannerTestDeps = {
  readConfigFileSnapshot?: typeof config.readConfigFileSnapshot;
  runCliAgent?: typeof cliRunner.runCliAgent;
  runEmbeddedAgent?: typeof embeddedAgent.runEmbeddedAgent;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
};

export async function planSystemAgentCommand(
  params: Parameters<typeof planSystemAgentCommandImpl>[0] & {
    deps?: PlannerTestDeps;
  },
) {
  const { deps, ...plannerParams } = params;
  const { readConfigFileSnapshot, runCliAgent, runEmbeddedAgent, createTempDir, removeTempDir } =
    deps ?? {};
  const mocks: Array<{ mockRestore(): void }> = [];
  try {
    if (readConfigFileSnapshot) {
      mocks.push(
        vi.spyOn(config, "readConfigFileSnapshot").mockImplementation(readConfigFileSnapshot),
      );
    }
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
    return await planSystemAgentCommandImpl(plannerParams);
  } finally {
    for (const mock of mocks.toReversed()) {
      mock.mockRestore();
    }
  }
}
