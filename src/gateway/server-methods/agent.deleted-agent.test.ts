import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { agentHandlers } from "./agent.js";
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

async function invoke(
  id: string,
  params: Record<string, unknown>,
  client: Parameters<NonNullable<typeof agentHandlers.agent>>[0]["client"] = null,
) {
  const respond = vi.fn<RespondFn>();
  const dedupe = new Map();
  await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
    agentHandlers,
    {
      req: { id } as never,
      params: { sessionKey: mockDeletedAgentSession(), ...params },
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
