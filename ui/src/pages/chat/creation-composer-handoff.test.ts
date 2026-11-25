// @vitest-environment node
import { expect, it, onTestFinished, vi } from "vitest";
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
import { persistChatComposerState } from "./composer-draft-storage.ts";
import {
  isIncognitoComposerScope,
  retainCreatedIncognitoComposerScope,
} from "./composer-persistence-state.ts";
import { admitCreatedComposerQueue } from "./creation-composer-handoff.ts";
import { connectCreatedComposerQueue } from "./creation-composer-recovery.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import * as payloads from "./outbox-payloads.ts";

useChatSendBrowserFixture();

const transfer = (overrides: Partial<CreationComposerTransfer> = {}): CreationComposerTransfer => ({
  sessionKey: "agent:main:canonical-created",
  draft: "unfinished",
  mentions: [],
  attachments: [],
  reads: new ChatAttachmentReadLifecycle(vi.fn()),
  inputs: [
    { id: "first", text: "first follower", attachments: [], createdAt: 20 },
    // Wall-clock reversal cannot reverse submission order.
    { id: "second", text: "second follower", attachments: [], createdAt: 10 },
  ],
  incognito: false,
  initialRejected: false,
  isCurrent: () => true,
  claimDraft: () => true,
  complete: vi.fn(),
  onInvalidate: () => () => {},
  ...overrides,
});

function deferPayload() {
  const prepared = createDeferred<Awaited<ReturnType<typeof payloads.prepareOutboxPayload>>>();
  vi.spyOn(payloads, "prepareOutboxPayload").mockImplementationOnce(() => prepared.promise);
  return prepared;
}

function connectQueue(
  host: ReturnType<typeof makeChatHost>,
  resume: ReturnType<typeof fixture>["resume"],
) {
  const listeners = new Set<() => void>();
  const resumed = createDeferred();
  resume.mockImplementation(async () => resumed.resolve());
  const context = {
    resumed: resumed.promise,
    gateway: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish: () => listeners.forEach((listener) => listener()),
  };
  onTestFinished(connectCreatedComposerQueue(context, host, transfer()));
  return context;
}

function fixture() {
  const host = makeChatHost({ sessionKey: "agent:main:canonical-created", requestHandlers: {} });
  const resume = vi.spyOn(actions, "resumeStoredChatOutboxes").mockResolvedValue();
  const admission = captureChatOutboxAdmission(host, host.sessionKey);
  const owner = chatOutboxOwner(host);
  const scope = admission.scope;
  function keepLater(fields: Partial<Parameters<typeof owner.keep>[2]> = {}) {
    const later = owner.keep(host, scope, {
      id: "later",
      text: "later input",
      createdAt: 30,
      sendState: "waiting-idle",
      ...fields,
    });
    expect(owner.admit(host, admission, later)).toBe("admitted");
    return later;
  }
  return { host, resume, owner, scope, keepLater };
}

it("preserves later delivery state when concurrent panes finish the same transfer", async () => {
  const { host, owner, scope, resume } = fixture();
  const input = transfer();
  const peer = makeChatHost({ sessionKey: host.sessionKey, client: host.client });
  onTestFinished(owner.subscribe(host));
  onTestFinished(owner.subscribe(peer));
  const prepared = deferPayload();
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
  expect(owner.snapshot(host, scope)[0]).toMatchObject({
    sendState: "failed",
    sendError: "Delivery rejected",
  });
  expect(resume).toHaveBeenCalledOnce();
});

it.each(["initial rejection", "payload failure"])("holds followers after %s", async (failure) => {
  const { host, owner, scope, resume } = fixture();
  const initialRejected = failure === "initial rejection";
  if (!initialRejected) {
    vi.spyOn(payloads, "prepareOutboxPayload").mockResolvedValueOnce({
      status: "failed",
      reason: "unavailable",
    });
  }
  await admitCreatedComposerQueue(host, transfer({ initialRejected }));
  const sendError = initialRejected ? expect.stringContaining("first message") : expect.any(String);
  expect(owner.snapshot(host, scope)).toMatchObject([
    { id: "first", sendState: "held", sendError },
    { id: "second", sendState: "held", ...(initialRejected ? { sendError } : {}) },
  ]);
  expect(resume).not.toHaveBeenCalled();
  if (!initialRejected) {
    expect(owner.admissions.has(scope)).toBe(true);
    expect(owner.remove(host, "first", { discard: true })?.text).toBe("first follower");
    expect(owner.admissions.has(scope)).toBe(false);
  }
});

it("blocks fresh and background delivery from overtaking asynchronous attachment admission", async () => {
  const { host, owner, scope, keepLater } = fixture();
  const prepared = deferPayload();
  const adoption = admitCreatedComposerQueue(host, transfer());
  expect(owner.admissions.has(scope)).toBe(true);
  const later = keepLater({ sendRunId: "new-run", sendAttempts: 0 });
  expect(finishChatDeliveryAdmission(host, later, "durable", host.sessionKey)).toBe("pending");
  const send = vi.fn(async () => "sent" as const);
  await scheduleStoredChatOutboxDrain(host, scope, { sendQueuedChatMessage: send });
  expect(send).not.toHaveBeenCalled();
  prepared.resolve({ status: "ready", update: {} });
  await adoption;
  expect(owner.admissions.has(scope)).toBe(false);
  expect(owner.snapshot(host, scope).map((item) => item.id)).toEqual(["first", "second", "later"]);
});

it("resumes the same ordered batch after a replacement client interrupts payload admission", async () => {
  const { host, owner, scope, resume } = fixture();
  const prepared = deferPayload();
  const context = connectQueue(host, resume);
  const ids = host.chatQueue.map((item) => [item.id, item.sendRunId]);
  expect(owner.admissions.has(scope)).toBe(true);
  host.client = createTestGatewayClient(host.request);
  context.publish();
  prepared.resolve({ status: "ready", update: {} });
  await context.resumed;
  expect(host.chatQueue.map((item) => [item.id, item.sendRunId])).toEqual(ids);
  expect(host.chatQueue.every((item) => item.sendState === "waiting-idle")).toBe(true);
  expect(owner.admissions.has(scope)).toBe(false);
  expect(resume).toHaveBeenCalledOnce();
  context.publish();
  expect(resume).toHaveBeenCalledOnce();
});

it("recovers still-volatile input in a remounted pane without replaying or dropping its IDs", async () => {
  const { host, owner, scope } = fixture();
  const input = transfer();
  const prepared = deferPayload();
  const first = admitCreatedComposerQueue(host, input);
  const ids = host.chatQueue.map((item) => [item.id, item.sendRunId]);
  host.connected = false;
  const remounted = makeChatHost({ sessionKey: host.sessionKey, client: host.client });
  const second = admitCreatedComposerQueue(remounted, input);
  prepared.resolve({ status: "ready", update: {} });
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(remounted.chatQueue.map((item) => [item.id, item.sendRunId])).toEqual(ids);
  expect(owner.admissions.has(scope)).toBe(false);
  expect(input.complete).toHaveBeenCalledOnce();
});

it("waits for recovery before adopting and keeps staged input ahead of later offline messages", async () => {
  const { host, resume, keepLater } = fixture();
  const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
  const context = connectQueue(host, resume);
  expect(host.chatQueue).toEqual([]);
  readiness.mockReturnValue(true);
  keepLater();
  context.publish();
  await context.resumed;
  expect(host.chatQueue.map((item) => item.id)).toEqual(["first", "second", "later"]);
});

it("releases admission barriers when the authenticated scope is revoked during payload preparation", async () => {
  const { host, owner, scope, resume } = fixture();
  const prepared = deferPayload();
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
  expect(owner.admissions.has(scope)).toBe(true);
  current = false;
  invalidate();
  expect(owner.admissions.has(scope)).toBe(false);
  prepared.resolve({ status: "ready", update: {} });
  expect(await admission).toBe(false);
  expect(resume).not.toHaveBeenCalled();
});

it("never retargets a transferred batch after the pane changes conversation", async () => {
  const { host, owner, scope, resume } = fixture();
  const input = transfer();
  host.sessionKey = "agent:main:newer-conversation";
  expect(await admitCreatedComposerQueue(host, input)).toBe(false);
  expect(owner.snapshot(host, scope)).toEqual([]);
  expect(listStoredChatOutboxes(host)).toEqual([]);
  expect(resume).not.toHaveBeenCalled();
});

it("keeps a canonicalized private draft out of persistence before roster metadata arrives", () => {
  const { host, scope } = fixture();
  host.selectedChatSessionIncognito = false;
  retainCreatedIncognitoComposerScope(host);
  host.chatMessage = "private unsent follow-up";
  expect(isIncognitoComposerScope(host, scope)).toBe(true);
  expect(persistChatComposerState(host)).toBe(true);
  expect(JSON.stringify(sessionStorage)).not.toContain("private unsent follow-up");
  expect(isIncognitoComposerScope(host, { ...scope, sessionKey: "agent:main:other" })).toBe(false);
});
