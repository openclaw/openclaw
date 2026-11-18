import os from "node:os";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import {
  createConfigOverride,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  supportedSpawnModelChoice,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  prepareModelChoiceMock: vi.fn<typeof supportedSpawnModelChoice>(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  startQueuedSubagentRunMock: vi.fn(),
  settleFailedQueuedSubagentLaunchMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
}));

let configOverride: Record<string, unknown>;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    ...hoisted,
    getRuntimeConfig: () => configOverride,
    resolveAgentConfig: (cfg: OpenClawConfig, agentId: string) => cfg.agents?.entries?.[agentId],
    sessionStorePath: "/tmp/subagent-access-program-session-store.json",
  }));
});

beforeEach(async () => {
  await resetSubagentRegistryForTests();
  for (const mock of Object.values(hoisted)) {
    mock.mockReset();
  }
  hoisted.prepareModelChoiceMock.mockImplementation(supportedSpawnModelChoice);
  hoisted.startQueuedSubagentRunMock.mockResolvedValue(true);
  hoisted.settleFailedQueuedSubagentLaunchMock.mockResolvedValue(true);
  installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
  configOverride = createConfigOverride({
    agents: {
      defaults: { workspace: os.tmpdir() },
      entries: {
        main: { workspace: "/tmp/workspace-main", subagents: { allowAgents: ["worker"] } },
        worker: { workspace: "/tmp/workspace-worker" },
      },
    },
  });
});

// Runtime x eligibility stays with the attempt guards; spawn owns only the session choice.
it.each([
  ["applies an explicit program", "daybreak_blue", undefined, {}, "daybreak_blue"],
  ["explicit Standard replaces inherited Blue", "standard", "daybreak_blue", {}, "standard"],
  ["explicit Red replaces inherited Blue", "daybreak_red", "daybreak_blue", {}, "daybreak_red"],
  ["inherits for the same agent and model", undefined, "daybreak_blue", {}, "daybreak_blue"],
  ["inherits Red for the same agent and model", undefined, "daybreak_red", {}, "daybreak_red"],
  ["leaves an unset requester at the model default", undefined, undefined, {}, undefined],
  [
    "does not inherit onto another model",
    undefined,
    "daybreak_blue",
    { model: "openai/other-model" },
    undefined,
  ],
  [
    "does not inherit onto another agent",
    undefined,
    "daybreak_blue",
    { agentId: "worker" },
    undefined,
  ],
  [
    "applies an explicit program to another agent",
    "daybreak_blue",
    undefined,
    { agentId: "worker" },
    "daybreak_blue",
  ],
] as const)("%s", async (_name, requested, saved, request, expected) => {
  hoisted.loadSessionStoreMock.mockReturnValue({
    "agent:main:main": saved === undefined ? {} : { cyberAccessProgram: saved },
  });
  let captured: Record<string, Record<string, unknown>> = {};
  installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
    onStore: (store) => {
      captured = store;
    },
  });

  const result = await spawnSubagentDirect(
    {
      task: "access program",
      ...request,
      ...(requested ? { cyberAccessProgram: requested } : {}),
    },
    { agentSessionKey: "agent:main:main" },
  );

  expect(result.status).toBe("accepted");
  expect(captured[result.childSessionKey!]?.cyberAccessProgram).toBe(expected);
  expect(result.cyberAccessProgram).toBe(expected);
});
