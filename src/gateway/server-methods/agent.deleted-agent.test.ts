/**
 * Tests that the agent RPC rejects deleted-agent sessions before dispatch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { agentHandlers } from "./agent.js";
import {
  mockDeletedAgentSession,
  resetDeletedAgentSessionMocks,
} from "./deleted-agent-guard.test-helpers.js";
import type { RespondFn } from "./types.js";

const agentCommandFromIngressMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromIngress: agentCommandFromIngressMock,
}));

describe("agent RPC deleted-agent guard", () => {
  beforeEach(() => {
    resetDeletedAgentSessionMocks();
    agentCommandFromIngressMock.mockReset();
  });

  it("rejects keys belonging to a deleted agent", async () => {
    const orphanKey = mockDeletedAgentSession();

    const respond = vi.fn() as unknown as RespondFn;

    await agentHandlers.agent({
      req: { id: "req-1" } as never,
      params: {
        sessionKey: orphanKey,
        message: "hi",
        idempotencyKey: "run-1",
      },
      respond,
      context: {
        dedupe: new Map(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
  });
});
