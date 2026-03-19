import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, vi } from "vitest";
import { __testing as discordThreadBindingTesting } from "../../../../extensions/discord/src/monitor/thread-bindings.manager.js";
import { __testing as feishuThreadBindingTesting } from "../../../../extensions/feishu/src/thread-bindings.js";
import {
  createMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
} from "../../../../extensions/matrix/src/matrix/thread-bindings.js";
import { setMatrixRuntime } from "../../../../extensions/matrix/src/runtime.js";
import { __testing as telegramThreadBindingTesting } from "../../../../extensions/telegram/src/thread-bindings.js";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { sessionBindingContractRegistry } from "./registry.js";
import { installSessionBindingContractSuite } from "./suites.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "$matrix-contract", roomId: "!room:example" })),
);

vi.mock("fake-indexeddb/auto", () => ({}));
vi.mock("../../../../extensions/matrix/src/matrix/send.js", () => ({
  sendMessageMatrix: sendMessageMatrixMock,
}));

const matrixContractStateDirs = new Set<string>();
const MATRIX_CONTRACT_STATE_DIR_ENV = "OPENCLAW_MATRIX_CONTRACT_STATE_DIR";
const matrixAuth = {
  accountId: "default",
  homeserver: "https://matrix.example.org",
  userId: "@ops:example.org",
  accessToken: "matrix-contract-token",
  deviceId: "DEVICEID",
};

function createMatrixContractEnv(): NodeJS.ProcessEnv {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-contracts-"));
  matrixContractStateDirs.add(stateDir);
  return {
    ...process.env,
    [MATRIX_CONTRACT_STATE_DIR_ENV]: stateDir,
  };
}

function cleanupMatrixContractState(): void {
  for (const stateDir of matrixContractStateDirs) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  matrixContractStateDirs.clear();
}

function resetMatrixSessionBindingContractStateForTests(): void {
  resetMatrixThreadBindingsForTests();
  cleanupMatrixContractState();
}

setMatrixRuntime({
  state: {
    resolveStateDir: (env) => env[MATRIX_CONTRACT_STATE_DIR_ENV] ?? os.tmpdir(),
  },
} as never);

const matrixEntry = sessionBindingContractRegistry.find((entry) => entry.id === "matrix");
if (!matrixEntry) {
  throw new Error("Matrix session binding contract entry is missing");
}

Object.assign(matrixEntry, {
  getCapabilities: async () => {
    await createMatrixThreadBindingManager({
      accountId: "default",
      auth: matrixAuth,
      client: {} as never,
      env: createMatrixContractEnv(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      enableSweeper: false,
    });
    return getSessionBindingService().getCapabilities({
      channel: "matrix",
      accountId: "default",
    });
  },
  bindAndResolve: async () => {
    await createMatrixThreadBindingManager({
      accountId: "default",
      auth: matrixAuth,
      client: {} as never,
      env: createMatrixContractEnv(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      enableSweeper: false,
    });
    const service = getSessionBindingService();
    const binding = await service.bind({
      targetSessionKey: "agent:matrix:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "$thread-1",
        parentConversationId: "!room:example",
      },
      placement: "current",
      metadata: {
        label: "codex-matrix",
      },
    });
    expect(
      service.resolveByConversation({
        channel: "matrix",
        accountId: "default",
        conversationId: "$thread-1",
        parentConversationId: "!room:example",
      }),
    )?.toMatchObject({
      targetSessionKey: "agent:matrix:subagent:child-1",
    });
    return binding;
  },
  unbindAndVerify: async (binding: SessionBindingRecord) => {
    const service = getSessionBindingService();
    const removed = await service.unbind({
      bindingId: binding.bindingId,
      reason: "contract-test",
    });
    expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
    expect(service.resolveByConversation(binding.conversation)).toBeNull();
  },
  cleanup: async () => {
    resetMatrixSessionBindingContractStateForTests();
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "matrix",
        accountId: "default",
        conversationId: "$thread-1",
        parentConversationId: "!room:example",
      }),
    ).toBeNull();
  },
});

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  discordThreadBindingTesting.resetThreadBindingsForTests();
  feishuThreadBindingTesting.resetFeishuThreadBindingsForTests();
  resetMatrixSessionBindingContractStateForTests();
  telegramThreadBindingTesting.resetTelegramThreadBindingsForTests();
});

for (const entry of sessionBindingContractRegistry) {
  describe(`${entry.id} session binding contract`, () => {
    installSessionBindingContractSuite({
      expectedCapabilities: entry.expectedCapabilities,
      getCapabilities: entry.getCapabilities,
      bindAndResolve: entry.bindAndResolve,
      unbindAndVerify: entry.unbindAndVerify,
      cleanup: entry.cleanup,
    });
  });
}
