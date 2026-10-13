import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  mockDeletedAgentSession,
  resetDeletedAgentSessionMocks,
} from "./deleted-agent-guard.test-helpers.js";
import type { RespondFn } from "./types.js";

const agentCommandFromIngressMock = vi.hoisted(() => vi.fn());
const performGatewaySessionResetMock = vi.hoisted(() => vi.fn());
const parseMessageWithAttachmentsMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: agentCommandFromIngressMock,
  agentCommandFromIngress: agentCommandFromIngressMock,
}));

vi.mock("../session-reset-service.js", () => ({
  performGatewaySessionReset: performGatewaySessionResetMock,
  emitGatewaySessionEndPluginHook: vi.fn(),
  emitGatewaySessionStartPluginHook: vi.fn(),
}));

vi.mock("../chat-attachments.js", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-attachments.js")>("../chat-attachments.js");
  return {
    ...actual,
    parseMessageWithAttachments: parseMessageWithAttachmentsMock,
  };
});

// Load the handler after the shared helper has registered its storage mocks.
const { agentHandlers } = await import("./agent.js");

async function invoke(
  id: string,
  params: Record<string, unknown>,
  client: Parameters<NonNullable<typeof agentHandlers.agent>>[0]["client"] = null,
  pending?: { dedupe: Map<string, unknown>; sessionKey: string },
) {
  const respond = vi.fn<RespondFn>();
  const dedupe = pending?.dedupe ?? new Map();
  await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
    agentHandlers,
    {
      req: { id } as never,
      params: { sessionKey: pending?.sessionKey ?? mockDeletedAgentSession(), ...params },
      respond,
      context: {
        dedupe,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
      } as never,
      client,
      isWebchatConnect: () => false,
    },
  );
  return { respond, dedupe };
}

describe("agent RPC deleted-agent guard", () => {
  beforeEach(() => {
    resetDeletedAgentSessionMocks();
    agentCommandFromIngressMock.mockReset();
    performGatewaySessionResetMock.mockReset();
    parseMessageWithAttachmentsMock.mockReset();
  });

  it("rejects deleted-agent sessions before media offload or dedupe reservation", async () => {
    const { respond, dedupe } = await invoke("req-attach", {
      message: "see attachment",
      idempotencyKey: "run-attach",
      attachments: [
        { type: "file", mimeType: "application/pdf", fileName: "doc.pdf", content: "aGVsbG8=" },
      ],
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
    expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
    expect(dedupe.size).toBe(0);
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
  });

  it("reserves an ACP request while metadata is pending and clears a refused reservation", async () => {
    const started = Promise.withResolvers<void>();
    const metadata = Promise.withResolvers<string | null>();
    const sessionKey = mockDeletedAgentSession(
      "agent:claude:acp:11111111-1111-4111-8111-111111111111",
      () => {
        started.resolve();
        return metadata.promise;
      },
    );
    const dedupe = new Map<string, unknown>();
    const pending = invoke("req-acp", { message: "hi", idempotencyKey: "run-acp" }, null, {
      dedupe,
      sessionKey,
    });
    try {
      await awaitGateBeforeSettlement(
        started.promise,
        pending.then(({ respond }) => expect(respond).not.toHaveBeenCalled()),
        "ACP request settled before its metadata check",
      );
      expect(dedupe.size).toBeGreaterThan(0);
      expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
      metadata.resolve("claude");
      const { respond } = await pending;
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "claude" no longer exists in configuration',
      });
      expect(dedupe.size).toBe(0);
      expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
    } finally {
      metadata.resolve("claude");
      await pending;
    }
  });

  it.each(["/reset", "/reset follow up"])(
    "rejects deleted-agent session keys before %s handling",
    async (message) => {
      const { respond } = await invoke(
        "req-reset",
        { message, idempotencyKey: `run-reset-${message}` },
        { connect: { scopes: ["operator.admin"] } } as never,
      );

      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      });
      expect(performGatewaySessionResetMock).not.toHaveBeenCalled();
      expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
    },
  );

  it("rejects deleted-agent sessions before stale exec followup dedupe", async () => {
    const { respond, dedupe } = await invoke(
      "req-followup",
      {
        message: "approval followup",
        idempotencyKey: "exec-approval-followup:req-followup",
        execApprovalFollowupExpectedSessionId: "old-session",
      },
      { connect: { client: { mode: "backend" } } } as never,
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
    expect(dedupe.size).toBe(0);
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
  });
});
