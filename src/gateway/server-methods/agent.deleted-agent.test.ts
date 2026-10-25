import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
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

vi.mock("../chat-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chat-attachments.js")>()),
  parseMessageWithAttachments: parseMessageWithAttachmentsMock,
}));

// Load the handler after the shared helper has registered its storage mocks.
const { agentHandlers } = await import("./agent.js");
const handleAgent = expectDefined(agentHandlers.agent, "agent RPC handler");

async function invoke(
  id: string,
  params: Record<string, unknown>,
  client: Parameters<typeof handleAgent>[0]["client"] = null,
  pending?: { dedupe: Map<string, unknown>; sessionKey: string; agent: string },
) {
  const respond = vi.fn<RespondFn>();
  const dedupe = pending?.dedupe ?? new Map();
  await handleAgent({
    req: { type: "req", method: "agent", id },
    params: { sessionKey: pending?.sessionKey ?? mockDeletedAgentSession(), ...params },
    respond,
    context: { dedupe, getRuntimeConfig: () => ({}) } as never,
    client,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledWith(false, undefined, {
    code: ErrorCodes.INVALID_REQUEST,
    message: `Agent "${pending?.agent ?? "deleted-agent"}" no longer exists in configuration`,
  });
  expect(dedupe.size).toBe(0);
  expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
  return { respond, dedupe };
}

beforeEach(() => {
  resetDeletedAgentSessionMocks();
  agentCommandFromIngressMock.mockReset();
  performGatewaySessionResetMock.mockReset();
  parseMessageWithAttachmentsMock.mockReset();
});

it.each([
  { id: "attach", message: "see attachment", attachment: true },
  { id: "reset", message: "/reset", admin: true },
  { id: "reset", message: "/reset follow up", admin: true },
  { id: "followup", message: "approval followup", backend: true },
])(
  "agent RPC rejects deleted-agent $message before side effects",
  async ({ id, message, attachment, admin, backend }) => {
    const client = admin
      ? ({ connect: { scopes: ["operator.admin"] } } as never)
      : backend
        ? ({ connect: { client: { mode: "backend" } } } as never)
        : null;
    const params: Record<string, unknown> = {
      message,
      idempotencyKey: backend
        ? "exec-approval-followup:req-followup"
        : admin
          ? `run-reset-${message}`
          : "run-attach",
    };
    if (backend) {
      params.execApprovalFollowupExpectedSessionId = "old-session";
    }
    if (attachment) {
      params.attachments = [
        { type: "file", mimeType: "application/pdf", fileName: "doc.pdf", content: "aGVsbG8=" },
      ];
    }
    await invoke(`req-${id}`, params, client);
    if (attachment) {
      expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
    }
    if (admin) {
      expect(performGatewaySessionResetMock).not.toHaveBeenCalled();
    }
  },
);

it("agent RPC reserves pending ACP metadata and clears a refused reservation", async () => {
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
    agent: "claude",
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
    await pending;
  } finally {
    metadata.resolve("claude");
    await pending;
  }
});
