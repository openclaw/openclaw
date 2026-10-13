// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { CreationComposerTransfer } from "../new-session/creation-composer.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { scheduleStoredChatOutboxDrain } from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import * as actions from "./chat-send-actions.ts";
import { finishChatDeliveryAdmission } from "./chat-send-queue-state.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import {
  isIncognitoComposerScope,
  retainCreatedIncognitoComposerScope,
} from "./composer-persistence-state.ts";
import { persistChatComposerState } from "./composer-persistence.ts";
import { admitCreatedComposerQueue } from "./creation-composer-handoff.ts";
import { connectCreatedComposerQueue } from "./creation-composer-recovery.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import * as payloads from "./outbox-payloads.ts";

useChatSendBrowserFixture();

function transfer(overrides: Partial<CreationComposerTransfer> = {}): CreationComposerTransfer {
  return {
    sessionKey: "agent:main:canonical-created",
    draft: "unfinished",
    mentions: [],
    attachments: [],
    reads: new ChatAttachmentReadLifecycle(vi.fn()),
    inputs: [
      { id: "first-input", text: "first follower", attachments: [], createdAt: 20 },
      // Wall-clock reversal cannot reverse submission order.
      { id: "second-input", text: "second follower", attachments: [], createdAt: 10 },
    ],
    incognito: false,
    initialRejected: false,
    isCurrent: () => true,
    claimDraft: () => true,
    complete: vi.fn(),
    onInvalidate: () => () => {},
    ...overrides,
  };
}

function fixture() {
  const host = makeChatHost({ sessionKey: "agent:main:canonical-created", requestHandlers: {} });
  const resume = vi.spyOn(actions, "resumeStoredChatOutboxes").mockResolvedValue();
  const scope = captureChatOutboxAdmission(host, host.sessionKey);
  return { host, resume, owner: chatOutboxOwner(host), scope };
}

describe("created-composer canonical outbox admission", () => {
  it("keeps IDs and submission order, then wakes the existing drain under only the accepted key", async () => {
    const { host, owner, scope, resume } = fixture();
    await admitCreatedComposerQueue(host, transfer());
    const queue = owner.snapshot(host, scope.scope);
    expect(queue.map((item) => item.id)).toEqual(["first-input", "second-input"]);
    expect(queue.every((item) => item.sessionKey === host.sessionKey)).toBe(true);
    expect(
      queue.every((item) => item.sendState === "waiting-idle" && item.sendAttempts === 0),
    ).toBe(true);
    expect(listStoredChatOutboxes(host)).toHaveLength(1);
    expect(owner.admissions.has(scope.scope)).toBe(false);
    expect(resume).toHaveBeenCalledExactlyOnceWith(host);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
  });

  it("adopts queued followers through the recovery driver for an equivalent pane key", async () => {
    const { host, owner, scope, resume } = fixture();
    const input = transfer({ sessionKey: host.sessionKey.toUpperCase() });
    const resumed = createDeferred();
    resume.mockImplementation(async () => {
      resumed.resolve();
    });
    const disconnect = connectCreatedComposerQueue(
      { gateway: { subscribe: () => () => {} } },
      host,
      input,
    );
    onTestFinished(disconnect);
    expect(owner.snapshot(host, scope.scope).map((item) => item.id)).toEqual([
      "first-input",
      "second-input",
    ]);
    await resumed.promise;
    expect(
      owner.snapshot(host, scope.scope).every((item) => item.sendState === "waiting-idle"),
    ).toBe(true);
    expect(input.complete).toHaveBeenCalledOnce();
  });

  it("preserves later delivery state when concurrent panes finish the same transfer", async () => {
    const { host, owner, scope, resume } = fixture();
    const input = transfer();
    const peer = makeChatHost({ sessionKey: host.sessionKey, client: host.client });
    onTestFinished(owner.subscribe(host));
    onTestFinished(owner.subscribe(peer));
    const prepared = createDeferred<Awaited<ReturnType<typeof payloads.prepareOutboxPayload>>>();
    vi.spyOn(payloads, "prepareOutboxPayload").mockImplementationOnce(() => prepared.promise);
    const first = admitCreatedComposerQueue(host, input);
    const delivery = first.then(() =>
      owner.update(host, [
        {
          id: input.inputs[0]!.id,
          update: (item) => ({ ...item, sendState: "failed", sendError: "Delivery rejected" }),
        },
      ]),
    );
    const second = admitCreatedComposerQueue(peer, input);
    prepared.resolve({ status: "ready", update: {} });
    expect(await first).toBe(true);
    await delivery;
    expect(await second).toBe(true);

    await admitCreatedComposerQueue(peer, input);
    expect(owner.snapshot(host, scope.scope)[0]).toMatchObject({
      sendState: "failed",
      sendError: "Delivery rejected",
    });
    expect(resume).toHaveBeenCalledOnce();
  });

  it("holds every follower when the accepted session rejected its initial turn", async () => {
    const { host, owner, scope, resume } = fixture();
    await admitCreatedComposerQueue(host, transfer({ initialRejected: true }));
    expect(owner.snapshot(host, scope.scope)).toEqual([
      expect.objectContaining({
        id: "first-input",
        sendState: "held",
        sendError: expect.stringContaining("first message"),
      }),
      expect.objectContaining({
        id: "second-input",
        sendState: "held",
        sendError: expect.stringContaining("first message"),
      }),
    ]);
    expect(resume).not.toHaveBeenCalled();
  });

  it("blocks fresh and background delivery from overtaking asynchronous attachment admission", async () => {
    const { host, owner, scope } = fixture();
    const prepared = createDeferred<Awaited<ReturnType<typeof payloads.prepareOutboxPayload>>>();
    vi.spyOn(payloads, "prepareOutboxPayload").mockImplementationOnce(() => prepared.promise);
    const adoption = admitCreatedComposerQueue(host, transfer());
    expect(owner.admissions.has(scope.scope)).toBe(true);
    const later = owner.keep(host, scope.scope, {
      id: "new-composer-send",
      text: "new input during transfer",
      createdAt: 30,
      sendRunId: "new-run",
      sendState: "waiting-idle",
      sendAttempts: 0,
    });
    expect(owner.admit(host, scope, later)).toBe("admitted");
    expect(finishChatDeliveryAdmission(host, later, "durable", host.sessionKey)).toBe("pending");
    const send = vi.fn(async () => "sent" as const);
    await scheduleStoredChatOutboxDrain(host, scope.scope, {
      sendQueuedChatMessage: send,
    });
    expect(send).not.toHaveBeenCalled();
    prepared.resolve({ status: "ready", update: {} });
    await adoption;
    expect(owner.admissions.has(scope.scope)).toBe(false);
    expect(owner.snapshot(host, scope.scope).map((item) => item.id)).toEqual([
      "first-input",
      "second-input",
      "new-composer-send",
    ]);
  });

  it("keeps failed volatile custody and its shared barrier until explicit retry or discard", async () => {
    const { host, owner, scope, resume } = fixture();
    vi.spyOn(payloads, "prepareOutboxPayload").mockResolvedValueOnce({
      status: "failed",
      reason: "unavailable",
    });
    await admitCreatedComposerQueue(host, transfer());
    expect(owner.admissions.has(scope.scope)).toBe(true);
    expect(owner.snapshot(host, scope.scope)).toEqual([
      expect.objectContaining({
        id: "first-input",
        sendState: "held",
        sendError: expect.any(String),
      }),
      expect.objectContaining({ id: "second-input", sendState: "held" }),
    ]);
    expect(resume).not.toHaveBeenCalled();
    expect(owner.remove(host, "first-input", { discard: true })?.text).toBe("first follower");
    expect(owner.admissions.has(scope.scope)).toBe(false);
  });

  it("resumes the same ordered batch after a replacement client interrupts payload admission", async () => {
    const { host, owner, scope, resume } = fixture();
    const prepared = createDeferred<Awaited<ReturnType<typeof payloads.prepareOutboxPayload>>>();
    vi.spyOn(payloads, "prepareOutboxPayload").mockImplementationOnce(() => prepared.promise);
    const listeners = new Set<() => void>();
    const context = {
      gateway: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    };
    const resumed = createDeferred();
    resume.mockImplementation(async () => {
      resumed.resolve();
    });
    const disconnect = connectCreatedComposerQueue(context, host, transfer());
    onTestFinished(disconnect);
    const ids = host.chatQueue.map((item) => [item.id, item.sendRunId]);
    expect(owner.admissions.has(scope.scope)).toBe(true);
    host.client = createTestGatewayClient(host.request);
    for (const listener of listeners) {
      listener();
    }
    prepared.resolve({ status: "ready", update: {} });
    await resumed.promise;
    expect(host.chatQueue.map((item) => [item.id, item.sendRunId])).toEqual(ids);
    expect(host.chatQueue.every((item) => item.sendState === "waiting-idle")).toBe(true);
    expect(owner.admissions.has(scope.scope)).toBe(false);
    expect(resume).toHaveBeenCalledOnce();
    for (const listener of listeners) {
      listener();
    }
    expect(resume).toHaveBeenCalledOnce();
  });

  it("recovers still-volatile input in a remounted pane without replaying or dropping its IDs", async () => {
    const { host, owner, scope } = fixture();
    const input = transfer();
    const prepared = createDeferred<Awaited<ReturnType<typeof payloads.prepareOutboxPayload>>>();
    vi.spyOn(payloads, "prepareOutboxPayload").mockImplementationOnce(() => prepared.promise);
    const first = admitCreatedComposerQueue(host, input);
    const ids = host.chatQueue.map((item) => [item.id, item.sendRunId]);
    host.connected = false;
    const remounted = makeChatHost({ sessionKey: host.sessionKey, client: host.client });
    const second = admitCreatedComposerQueue(remounted, input);
    prepared.resolve({ status: "ready", update: {} });
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(remounted.chatQueue.map((item) => [item.id, item.sendRunId])).toEqual(ids);
    expect(owner.admissions.has(scope.scope)).toBe(false);
    expect(input.complete).toHaveBeenCalledOnce();
  });

  it("waits for recovery before adopting and keeps staged input ahead of later offline messages", async () => {
    const { host, owner, scope, resume } = fixture();
    const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
    const listeners = new Set<() => void>();
    const context = {
      gateway: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    };
    const resumed = createDeferred();
    resume.mockImplementation(async () => {
      resumed.resolve();
    });
    const disconnect = connectCreatedComposerQueue(context, host, transfer());
    onTestFinished(disconnect);
    expect(host.chatQueue).toEqual([]);
    readiness.mockReturnValue(true);
    const later = owner.keep(host, scope.scope, {
      id: "later",
      text: "typed after creation",
      createdAt: 30,
      sendState: "waiting-idle",
    });
    expect(owner.admit(host, scope, later)).toBe("admitted");
    for (const listener of listeners) {
      listener();
    }
    await resumed.promise;
    expect(host.chatQueue.map((item) => item.id)).toEqual(["first-input", "second-input", "later"]);
  });

  it("releases admission barriers when the authenticated scope is revoked during payload preparation", async () => {
    const { host, owner, scope, resume } = fixture();
    const prepared = createDeferred<Awaited<ReturnType<typeof payloads.prepareOutboxPayload>>>();
    vi.spyOn(payloads, "prepareOutboxPayload").mockImplementationOnce(() => prepared.promise);
    let current = true;
    let invalidate = () => {};
    const input = transfer({
      isCurrent: () => current,
      onInvalidate: (listener) => {
        invalidate = listener;
        return () => {};
      },
    });
    const admission = admitCreatedComposerQueue(host, input);
    expect(owner.admissions.has(scope.scope)).toBe(true);
    current = false;
    invalidate();
    expect(owner.admissions.has(scope.scope)).toBe(false);
    prepared.resolve({ status: "ready", update: {} });
    expect(await admission).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it("never retargets a transferred batch after the pane changes conversation", async () => {
    const { host, owner, scope, resume } = fixture();
    const input = transfer();
    host.sessionKey = "agent:main:newer-conversation";
    expect(await admitCreatedComposerQueue(host, input)).toBe(false);
    expect(owner.snapshot(host, scope.scope)).toEqual([]);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(resume).not.toHaveBeenCalled();
  });

  it("keeps a canonicalized private draft out of persistence before roster metadata arrives", () => {
    const { host, scope } = fixture();
    host.selectedChatSessionIncognito = false;
    retainCreatedIncognitoComposerScope(host);
    host.chatMessage = "private unsent follow-up";
    expect(isIncognitoComposerScope(host, scope.scope)).toBe(true);
    expect(persistChatComposerState(host)).toBe(true);
    expect(JSON.stringify(sessionStorage)).not.toContain("private unsent follow-up");
    expect(isIncognitoComposerScope(host, { ...scope.scope, sessionKey: "agent:main:other" })).toBe(
      false,
    );
  });
});
