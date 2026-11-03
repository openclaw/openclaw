import os from "node:os";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import {
  createConfigOverride,
  createThinkingProvenanceCases,
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
const thinkingCases = createThinkingProvenanceCases();

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    ...hoisted,
    getRuntimeConfig: () => configOverride,
    resolveAgentConfig: (cfg: OpenClawConfig, agentId: string) => cfg.agents?.entries?.[agentId],
    sessionStorePath: "/tmp/subagent-thinking-provenance-session-store.json",
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
});

it.each(thinkingCases)("%s", async (name, context, saved, expected, thinking, thinkingDefault) => {
  configOverride = createConfigOverride({
    agents: {
      defaults: {
        workspace: os.tmpdir(),
        ...(thinkingDefault ? { thinkingDefault } : {}),
      },
      entries: { main: { workspace: "/tmp/workspace-main" } },
    },
  });
  hoisted.loadSessionStoreMock.mockReturnValue({
    "agent:main:main": saved === undefined ? {} : { thinkingLevel: saved },
  });
  let captured: Record<string, Record<string, unknown>> = {};
  installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
    onStore: (store) => {
      captured = store;
    },
  });
  const result = await spawnSubagentDirect(
    { task: `provenance: ${name}`, thinking },
    { agentSessionKey: "agent:main:main", ...context },
  );

  expect(result.status).toBe("accepted");
  expect(captured[result.childSessionKey!]?.thinkingLevel).toBe(expected);
});
