// Chat admission must attach the authenticated operator before any turn effects.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getAgentRunContext } from "../../infra/agent-events.js";
import { createAuthorizationPrincipal } from "../../plugins/authorization-policy-context.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import {
  isSessionWorkAdmissionActive,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

const testState = vi.hoisted(() => ({
  admission: undefined as SessionWorkAdmissionLease | undefined,
  preAdmittedAuthority: undefined as TurnAuthoritySnapshot | undefined,
  sessionId: "chat-authority-session",
  sessionKey: "agent:main:main",
  storePath: "",
}));

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn(),
}));

vi.mock("../../sessions/session-lifecycle-admission.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../sessions/session-lifecycle-admission.js")
  >("../../sessions/session-lifecycle-admission.js");
  return {
    ...actual,
    beginSessionWorkAdmission: async (
      params: Parameters<typeof actual.beginSessionWorkAdmission>[0],
    ) => {
      const admission = await actual.beginSessionWorkAdmission(params);
      testState.admission = admission;
      if (testState.preAdmittedAuthority) {
        admission.setTurnAuthority(testState.preAdmittedAuthority);
      }
      return admission;
    },
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: () => {
      const entry = {
        sessionId: testState.sessionId,
        sessionFile: path.join(path.dirname(testState.storePath), `${testState.sessionId}.jsonl`),
      };
      return {
        cfg: {
          agents: { list: [{ id: "main", default: true }] },
          session: { mainKey: "main" },
        },
        storePath: testState.storePath,
        store: { [testState.sessionKey]: entry },
        entry,
        canonicalKey: testState.sessionKey,
      };
    },
  };
});

function createContext() {
  return {
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    broadcastToConnIds: vi.fn(),
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatAbortedRuns: new Map(),
    dedupe: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    clearChatRunState: vi.fn(),
    getRuntimeConfig: () => ({
      agents: { list: [{ id: "main", default: true }] },
      session: { mainKey: "main" },
    }),
    loadGatewayModelCatalog: vi.fn(async () => []),
    registerToolEventRecipient: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
}

describe("chat.send operator authority admission", () => {
  afterEach(() => {
    testState.admission?.release();
    testState.admission = undefined;
    testState.preAdmittedAuthority = undefined;
    vi.mocked(dispatchInboundMessage).mockReset();
  });

  it("rejects conflicting early authority before any turn effect and releases exact ownership", async () => {
    const runId = "chat-conflicting-operator-authority";
    testState.storePath = path.join(
      os.tmpdir(),
      `openclaw-chat-authority-${randomUUID()}`,
      "sessions.json",
    );
    testState.preAdmittedAuthority = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({
        provider: "discord",
        senderId: "legacy-owner",
        senderIsOwner: true,
      }),
      agentId: "main",
      sessionKey: testState.sessionKey,
      sessionId: testState.sessionId,
      runId: "legacy-run",
      conversationId: testState.sessionKey,
      trigger: "channel",
      controllerKey: "sender:legacy-owner",
    });
    const context = createContext();
    const respond = vi.fn();

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "main",
        message: "inspect the incident",
        idempotencyKey: runId,
      },
      respond: respond as never,
      context: context as unknown as GatewayRequestContext,
      req: {} as never,
      client: {
        connId: "conn-current-operator",
        pairedClientId: "paired-current-operator",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "openclaw-cli",
            version: "test",
            platform: "test",
            mode: "cli",
          },
          scopes: ["operator.write"],
          caps: [],
        },
      } as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "invalid Gateway turn authority",
      }),
    );
    expect(dispatchInboundMessage).not.toHaveBeenCalled();
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(context.removeChatRun).not.toHaveBeenCalled();
    expect(context.chatQueuedTurns.size).toBe(0);
    expect(context.chatAbortControllers.size).toBe(0);
    expect(context.dedupe.size).toBe(0);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.nodeSendToSession).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(path.dirname(testState.storePath), `${testState.sessionId}.jsonl`)),
    ).toBe(false);
    expect(getAgentRunContext(runId)).toBeUndefined();
    expect(
      isSessionWorkAdmissionActive(testState.storePath, [
        testState.sessionKey,
        testState.sessionId,
      ]),
    ).toBe(false);
    await expect(
      expectDefined(testState.admission, "chat admission test invariant").released,
    ).resolves.toBeUndefined();
  });
});
