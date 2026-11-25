import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { withFullRuntimeReplyConfig } from "../../auto-reply/reply/get-reply-fast-path.js";
import * as approvalGateway from "../../infra/approval-gateway-resolver.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { loadRealChatDispatch } from "./chat-send-authority.test-support.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

it("keeps a WebChat approval visible without invalidating the waiting turn or entering model context", async () => {
  const fixture = await createFixture({ preserveContent: true });
  fixture.activeRun?.setPhase("running");
  const manager = await SessionManager.openAsync(fixture.scope);
  const originalContext = manager.buildSessionContext().messages;
  const command = "/approve 54311abf-1c32-441f-a561-94ed429eeab1 allow-once";
  const confirmation = "✅ Approval allow-once submitted for 54311abf-1c32-441f-a561-94ed429eeab1.";
  const approval = vi.spyOn(approvalGateway, "resolveApprovalOverGateway").mockResolvedValue({
    applied: true,
    approval: {
      id: "54311abf-1c32-441f-a561-94ed429eeab1",
      urlPath: "/approvals/54311abf-1c32-441f-a561-94ed429eeab1",
      createdAtMs: 1,
      expiresAtMs: 3,
      resolvedAtMs: 2,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      presentation: {
        kind: "exec",
        commandText: "echo approved",
        allowedDecisions: ["allow-once", "deny"],
      },
    },
  });
  const config = withFullRuntimeReplyConfig(fixture.context.getRuntimeConfig());
  const dispatchActual = await loadRealChatDispatch();
  dispatchInboundMessageMock.mockImplementation((params: unknown) =>
    dispatchActual({ ...(params as Parameters<typeof dispatchInboundMessage>[0]), cfg: config }),
  );
  fixture.params.message = command;
  fixture.params.idempotencyKey = "webchat-approval";
  const terminal = createDeferred<Record<string, unknown>>();
  vi.mocked(fixture.context.broadcast).mockImplementation((event, payload) => {
    const frame = asOptionalRecord(payload);
    if (
      event === "chat" &&
      frame?.runId === fixture.params.idempotencyKey &&
      frame.state !== "delta"
    ) {
      terminal.resolve(frame);
    }
  });
  try {
    const response = await fixture.send(
      undefined,
      undefined,
      fixture.params,
      handleDirectExternalChatSend,
    );
    expect(response.mock.calls[0]?.[0]).toBe(true);
    expect(await terminal.promise).toMatchObject({
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: confirmation }] },
    });
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "54311abf-1c32-441f-a561-94ed429eeab1",
        decision: "allow-once",
        resolveMethod: "exec",
      }),
    );
    expect(fixture.activeRun?.phase).toBe("running");
    const messages = (await readVisibleSessionTranscriptMessageEntries(fixture.scope)).flatMap(
      ({ message }) =>
        message.role === "user" || message.role === "assistant"
          ? [{ role: message.role, text: extractTextFromChatContent(message.content) }]
          : [],
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        { role: "user", text: command },
        { role: "assistant", text: confirmation },
      ]),
    );
    const reopened = await SessionManager.openAsync(fixture.scope);
    expect.soft(reopened.buildSessionContext().messages).toEqual(originalContext);
    await expect
      .soft(
        manager.appendMessageAsync(
          buildAssistantMessage({
            model: { api: "openai-responses", provider: "openai", id: "synthetic" },
            content: [{ type: "text", text: "Approved work completed." }],
            stopReason: "stop",
            usage: buildUsageWithNoCost({}),
          }),
        ),
      )
      .resolves.toEqual(expect.any(String));
  } finally {
    approval.mockRestore();
    await fixture.cleanup();
  }
});
