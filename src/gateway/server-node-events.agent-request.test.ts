import "./server-node-events.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DurableMessageBatchSendResult } from "../channels/message/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const {
  buildSessionLookup,
  buildCtx,
  nodeEvent,
  eventResult,
  waitForFast,
  runAdmittedNodeEvent,
  expectSuspendBusyWithRootWork,
  expectSuspendReady,
  resetNodeEventTestState,
  sentDurableMessageBatchResult,
  parseMessageWithAttachmentsMock,
  persistInboundImagesForTranscriptMock,
  runtimeMocks,
} = await import("./server-node-events.test-support.js");

const agentCommandMock = runtimeMocks.agentCommandFromIngress;
const upsertSessionEntryMock = runtimeMocks.upsertSessionEntryCore;
const loadSessionEntryMock = runtimeMocks.loadSessionEntry;
const normalizeChannelIdVi = runtimeMocks.normalizeChannelId;
const sendDurableMessageBatchMock = runtimeMocks.sendDurableMessageBatch;

beforeEach(resetNodeEventTestState);
afterEach(resetGatewayWorkAdmission);

describe("agent request events", () => {
  beforeEach(() => {
    parseMessageWithAttachmentsMock.mockReset();
    persistInboundImagesForTranscriptMock.mockReset();
    persistInboundImagesForTranscriptMock.mockResolvedValue({ entries: [], omission: "none" });
    runtimeMocks.deleteMediaBuffer.mockClear();
    normalizeChannelIdVi.mockClear();
    normalizeChannelIdVi.mockImplementation((channel?: string | null) => channel ?? null);
    sendDurableMessageBatchMock.mockReset();
    sendDurableMessageBatchMock.mockResolvedValue(sentDurableMessageBatchResult);
    parseMessageWithAttachmentsMock.mockResolvedValue({
      message: "parsed message",
      images: [],
      imageOrder: [],
      offloadedRefs: [],
    });
  });

  it("rejects a missing harness-owned session before touching the store", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-request";
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    });

    await handleNodeEvent(
      buildCtx(),
      "node-harness-request-missing",
      nodeEvent("agent.request", { message: "do not create this", sessionKey }),
    );

    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong owner", { agentHarnessId: "other", modelSelectionLocked: true }],
    ["missing session id", { agentHarnessId: "codex", modelSelectionLocked: true, sessionId: "" }],
  ] as const)(
    "rejects a harness-owned agent request with %s before side effects",
    async (_label, entry) => {
      const sessionKey = `agent:main:harness:codex:supervision:invalid-request-${_label.replaceAll(" ", "-")}`;
      loadSessionEntryMock.mockReturnValueOnce(buildSessionLookup(sessionKey, entry));

      await handleNodeEvent(
        buildCtx(),
        "node-harness-request-invalid",
        nodeEvent("agent.request", {
          message: "do not dispatch this",
          sessionKey,
          attachments: [{ type: "image", mimeType: "image/png", content: "aGVsbG8=" }],
        }),
      );

      expect(runtimeMocks.resolveSessionAgentId).not.toHaveBeenCalled();
      expect(runtimeMocks.resolveSessionModelRef).not.toHaveBeenCalled();
      expect(runtimeMocks.resolveGatewayModelSupportsImages).not.toHaveBeenCalled();
      expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
      expect(upsertSessionEntryMock).not.toHaveBeenCalled();
      expect(persistInboundImagesForTranscriptMock).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
    },
  );

  it("keeps an accepted detached agent dispatch visible to suspension", async () => {
    const dispatch = createDeferred<never>();
    agentCommandMock.mockImplementationOnce(() => dispatch.promise);

    await runAdmittedNodeEvent(
      buildCtx(),
      "node-agent-suspend",
      nodeEvent("agent.request", {
        message: "finish before suspension",
        sessionKey: "agent:main:suspend-agent",
      }),
    );

    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
    expectSuspendBusyWithRootWork("agent-dispatch-busy");
    dispatch.resolve(undefined as never);
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expectSuspendReady("agent-dispatch-ready");
  });

  it("keeps an accepted detached receipt delivery visible to suspension", async () => {
    const receipt = createDeferred<DurableMessageBatchSendResult>();
    sendDurableMessageBatchMock.mockImplementationOnce(() => receipt.promise);

    await runAdmittedNodeEvent(
      buildCtx(),
      "node-receipt-suspend",
      nodeEvent("agent.request", {
        message: "acknowledge before suspension",
        sessionKey: "agent:main:suspend-receipt",
        deliver: true,
        receipt: true,
        channel: "telegram",
        to: "123",
      }),
    );

    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
    expectSuspendBusyWithRootWork("receipt-delivery-busy");
    receipt.resolve(sentDurableMessageBatchResult);
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expectSuspendReady("receipt-delivery-ready");
  });

  it("does not launch agent work when pairing changes during model lookup", async () => {
    const modelCatalog =
      createDeferred<Awaited<ReturnType<NodeEventContext["loadGatewayModelCatalog"]>>>();
    const ctx = buildCtx();
    ctx.loadGatewayModelCatalog = vi.fn(() => modelCatalog.promise);
    let connectionCurrent = true;
    const isConnectionCurrent = vi.fn(async () => connectionCurrent);

    const request = handleNodeEvent(
      ctx,
      "node-revoked-during-model-lookup",
      nodeEvent("agent.request", {
        message: "describe this image",
        sessionKey: "agent:main:revoked-during-model-lookup",
        attachments: [{ type: "image", mimeType: "image/png", content: "AAAA" }],
        deliver: true,
        receipt: true,
        channel: "telegram",
        to: "123",
      }),
      { isConnectionCurrent },
    );

    await waitForFast(() => expect(ctx.loadGatewayModelCatalog).toHaveBeenCalledTimes(1));
    connectionCurrent = false;
    modelCatalog.resolve([]);

    await expect(request).resolves.toEqual(eventResult("agent.request", "pairing_changed"));
    expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
    expect(sendDurableMessageBatchMock).not.toHaveBeenCalled();
    expect(persistInboundImagesForTranscriptMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("cleans persisted transcript media when detached agent admission is revoked", async () => {
    persistInboundImagesForTranscriptMock.mockResolvedValueOnce({
      entries: [
        {
          id: "saved-after-admission",
          path: "/media/inbound/saved-after-admission.png",
          sourceIndex: 0,
          imageKind: "inline",
          fact: { url: "media://inbound/saved-after-admission.png", contentType: "image/png" },
        },
      ],
      omission: "none",
    });
    let currentnessChecks = 0;
    const isConnectionCurrent = vi.fn(async () => {
      currentnessChecks += 1;
      return currentnessChecks < 6;
    });

    await handleNodeEvent(
      buildCtx(),
      "node-revoked-before-detached-start",
      nodeEvent("agent.request", {
        message: "do not retain this media",
        sessionKey: "agent:main:revoked-before-detached-start",
      }),
      { isConnectionCurrent },
    );

    await waitForFast(() => {
      expect(runtimeMocks.deleteMediaBuffer).toHaveBeenCalledWith("saved-after-admission");
    });
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "delivers only through the current session route (available: %s)",
    async (available) => {
      const warn = vi.fn();
      if (available) {
        loadSessionEntryMock.mockReturnValueOnce(
          buildSessionLookup("agent:main:main", {
            sessionId: "sid-current",
            lastChannel: "telegram",
            lastTo: "123",
          }),
        );
      }
      await handleNodeEvent(
        { ...buildCtx(), logGateway: { warn } },
        "node-route",
        nodeEvent("agent.request", {
          message: "summarize this",
          sessionKey: "agent:main:main",
          deliver: true,
        }),
      );
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      const opts: unknown = agentCommandMock.mock.calls[0]?.[0];
      expect(opts).toMatchObject({
        message: "summarize this",
        sessionKey: "agent:main:main",
        deliver: available,
        channel: available ? "telegram" : undefined,
        to: available ? "123" : undefined,
      });
      if (available) {
        expect(opts).toMatchObject({ runId: "sid-current", sessionId: "sid-current" });
      } else {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain(
          "agent delivery disabled node=node-route",
        );
      }
    },
  );
  it("records a visible durable omission when inline image persistence fails", async () => {
    parseMessageWithAttachmentsMock.mockResolvedValueOnce({
      message: "describe",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg", sourceIndex: 0 }],
      imageOrder: ["inline"],
      offloadedRefs: [],
    });
    persistInboundImagesForTranscriptMock.mockResolvedValueOnce({
      entries: [],
      omission: "inline-image-save-failed",
    });

    await handleNodeEvent(
      buildCtx(),
      "node-media-omission",
      nodeEvent("agent.request", {
        message: "describe",
        sessionKey: "agent:main:main",
        attachments: [{ type: "image", mimeType: "image/jpeg", content: "AAAA" }],
      }),
    );

    expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
      message: "describe",
      transcriptMessage:
        "describe\n[image attachment omitted: durable managed media claim unavailable]",
    });
  });

  it("declines non-image attachments cleanly when parse throws UnsupportedAttachmentError", async () => {
    const warn = vi.fn();
    const ctx = buildCtx();
    ctx.logGateway = { warn };

    parseMessageWithAttachmentsMock.mockRejectedValueOnce(
      Object.assign(new Error("attachment a.pdf: non-image attachments not supported"), {
        name: "UnsupportedAttachmentError",
        reason: "unsupported-non-image",
      }),
    );

    await handleNodeEvent(
      ctx,
      "node-non-image-refusal",
      nodeEvent("agent.request", {
        message: "read this",
        sessionKey: "agent:main:main",
        attachments: [
          {
            type: "file",
            mimeType: "application/pdf",
            fileName: "a.pdf",
            content: "JVBERi0=",
          },
        ],
      }),
    );

    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "agent.request attachment parse failed: attachment a.pdf: non-image attachments not supported",
    );
  });
});
