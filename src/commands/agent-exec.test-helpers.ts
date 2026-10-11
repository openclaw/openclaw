import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { AgentExecRunResult } from "./agent-exec-result.js";
import { agentExecCommand } from "./agent-exec.js";

export type AgentExecRunnerFixture = (
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) => Promise<AgentExecRunResult | undefined>;

const command = vi.hoisted(() => vi.fn<AgentExecRunnerFixture>());
vi.mock("./agent.js", () => ({ agentCommand: command }));

export function runAgentExecWithMock(
  message: Parameters<typeof agentExecCommand>[0],
  opts: Parameters<typeof agentExecCommand>[1],
  runtime: RuntimeEnv,
  runAgent: AgentExecRunnerFixture,
) {
  command.mockReset().mockImplementation(runAgent);
  return agentExecCommand(message, opts, runtime);
}
