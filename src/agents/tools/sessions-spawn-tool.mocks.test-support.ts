import { vi } from "vitest";
import type { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const spawnAcpDirectMock = vi.fn();
  const registerSubagentRunMock = vi.fn();
  const inProcessCreationMock = vi.fn();
  const runSubagentProgressMock = vi.fn(async () => {});
  const prepareModelChoiceMock = vi.fn<typeof supportedSpawnModelChoice>();
  return {
    spawnSubagentDirectMock,
    spawnAcpDirectMock,
    registerSubagentRunMock,
    inProcessCreationMock,
    runSubagentProgressMock,
    prepareModelChoiceMock,
  };
});

vi.mock("../subagents/spawn/subagent-spawn.runtime.js", () => ({
  prepareModelChoice: hoisted.prepareModelChoiceMock,
}));

vi.mock("../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../subagents/spawn/acp-spawn.js", () => ({
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));

vi.mock("../subagents/registry/subagent-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../subagents/registry/subagent-registry.js")>();
  return {
    ...actual,
    countActiveRunsForSession: () => 0,
    registerSubagentRun: (...args: unknown[]) => hoisted.registerSubagentRunMock(...args),
  };
});

vi.mock("./in-process-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./in-process-gateway.js")>();
  return {
    ...actual,
    callInProcessGatewayToolWithCreation: (...args: unknown[]) =>
      hoisted.inProcessCreationMock(...args),
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "subagent_progress",
    runSubagentProgress: hoisted.runSubagentProgressMock,
  }),
}));

export { hoisted };
