/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort has no targetOrigin. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { PluginUiBridgeController } from "./plugin-ui-bridge.ts";

const cleanups: Array<() => void> = [];

function messageInbox(port: MessagePort) {
  const messages: unknown[] = [];
  const readers: Array<(message: unknown) => void> = [];
  port.addEventListener("message", (event) => {
    const reader = readers.shift();
    if (reader) {
      reader(event.data);
    } else {
      messages.push(event.data);
    }
  });
  port.start();
  return {
    next: () =>
      new Promise<unknown>((resolve) => {
        if (messages.length > 0) {
          resolve(messages.shift());
        } else {
          readers.push(resolve);
        }
      }),
  };
}

function offerBridgePort(frame: HTMLIFrameElement, nonce: string) {
  const frameWindow = frame.contentWindow;
  if (!frameWindow) {
    throw new Error("expected iframe window");
  }
  const actionChannel = new MessageChannel();
  const documentChannel = new MessageChannel();
  const childPort = actionChannel.port1;
  const parentPort = actionChannel.port2;
  const childDocumentPort = documentChannel.port1;
  const parentDocumentPort = documentChannel.port2;
  const responses = messageInbox(childPort);
  const verifications = messageInbox(childDocumentPort);
  const closeActionPort = vi.spyOn(parentPort, "close");
  const closeDocumentPort = vi.spyOn(parentDocumentPort, "close");
  const postResponse = vi.spyOn(parentPort, "postMessage");
  cleanups.push(() => {
    childPort.close();
    parentPort.close();
    childDocumentPort.close();
    parentDocumentPort.close();
  });
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { v: 1, type: "openclaw.pluginUi.ready", nonce },
      source: frameWindow,
      ports: [parentPort, parentDocumentPort],
    }),
  );
  return {
    childPort,
    parentPort,
    childDocumentPort,
    parentDocumentPort,
    closeActionPort,
    closeDocumentPort,
    postResponse,
    responses,
    verifications,
  };
}

function createBridge() {
  const bridge = new PluginUiBridgeController();
  cleanups.push(() => bridge.clear());
  return bridge;
}

async function connectBridge(
  params: { request?: ReturnType<typeof vi.fn>; sessionActions?: string[] } = {},
) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const request = params.request ?? vi.fn(async () => ({ ok: true }));
  const bridge = createBridge();
  bridge.sync({
    frame,
    key: "notes/settings",
    nonce: "notes-nonce",
    pluginId: "notes",
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    sessionKey: "agent:main:active",
    contextTokens: 64_000,
    sessionActions: params.sessionActions ?? ["save"],
  });
  const offered = offerBridgePort(frame, "notes-nonce");
  const connectMessage = await offered.responses.next();
  return { bridge, connectMessage, frame, request, ...offered };
}

function sessionAction(id: string, contextRevision = 1) {
  return { v: 1, type: "openclaw.pluginUi.sessionAction", id, actionId: "save", contextRevision };
}

async function deliverMessage(sender: MessagePort, receiver: MessagePort, data: unknown) {
  // Registered after the owner's listener: resolution proves that this exact
  // native MessagePort task reached the owner, without polling or a timed sleep.
  const delivered = new Promise<void>((resolve) => {
    receiver.addEventListener("message", () => resolve(), { once: true });
  });
  sender.postMessage(data);
  await delivered;
}

async function queuedPortMessage(data: unknown): Promise<MessageEvent> {
  // Capture an actual port event so its realm matches the native MessagePort
  // even when the surrounding window is provided by jsdom.
  const channel = new MessageChannel();
  const queued = new Promise<MessageEvent>((resolve) => {
    channel.port2.addEventListener("message", resolve, { once: true });
    channel.port2.start();
  });
  channel.port1.postMessage(data);
  const event = await queued;
  channel.port1.close();
  channel.port2.close();
  return event;
}

function acknowledgeDocument(id: unknown) {
  return { v: 1, type: "openclaw.pluginUi.documentVerified", id };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("PluginUiBridgeController", () => {
  it.each([
    ["non-finite number", { value: Number.NaN }],
    ["infinity", { value: Number.POSITIVE_INFINITY }],
    ["date", { value: new Date(0) }],
    ["map", { value: new Map([["key", "value"]]) }],
    ["nested undefined", { value: undefined }],
    [
      "sparse array",
      {
        value: (() => {
          const value: unknown[] = [];
          value.length = 1;
          return value;
        })(),
      },
    ],
    ["bigint", { value: 1n }],
    [
      "cycle",
      (() => {
        const value: unknown[] = [];
        value.push(value);
        return value;
      })(),
    ],
  ])("rejects a structured-clone %s before Gateway serialization", async (_name, payload) => {
    const connected = await connectBridge();
    connected.childPort.postMessage({ ...sessionAction("invalid-payload"), payload });
    expect(await connected.responses.next()).toMatchObject({
      id: "invalid-payload",
      ok: false,
      error: "Plugin UI action payload must be JSON-compatible",
    });
    expect(connected.request).not.toHaveBeenCalled();
  });

  it("invokes only a declared plugin action with the parent session context", async () => {
    const request = vi.fn(async () => ({ ok: true, result: { saved: true } }));
    const connected = await connectBridge({ request, sessionActions: ["save"] });
    expect(connected.connectMessage).toMatchObject({
      v: 1,
      type: "openclaw.pluginUi.connect",
      capabilities: { sessionActions: ["save"] },
      context: { sessionKey: "agent:main:active", revision: 1, contextTokens: 64_000 },
    });
    connected.childPort.postMessage({
      ...sessionAction("save-1"),
      sessionKey: "agent:attacker:ignored",
      payload: { enabled: true },
    });
    expect(await connected.responses.next()).toEqual({
      v: 1,
      type: "openclaw.pluginUi.response",
      id: "save-1",
      ok: true,
      contextRevision: 1,
      result: { ok: true, result: { saved: true } },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("plugins.sessionAction", {
      pluginId: "notes",
      actionId: "save",
      sessionKey: "agent:main:active",
      payload: { enabled: true },
    });
  });

  it("rejects actions absent from the tab descriptor before Gateway dispatch", async () => {
    const connected = await connectBridge();
    connected.childPort.postMessage({
      ...sessionAction("delete-1"),
      actionId: "delete-everything",
    });
    expect(await connected.responses.next()).toMatchObject({
      id: "delete-1",
      ok: false,
      error: "Plugin UI action is not allowed",
    });
    expect(connected.request).not.toHaveBeenCalled();
  });

  it("requires the registered document nonce before the first connection", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const request = vi.fn();
    const bridge = createBridge();
    bridge.sync({
      frame,
      key: "notes/settings",
      nonce: "registered-document",
      pluginId: "notes",
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      sessionKey: "agent:main:active",
      sessionActions: ["save"],
    });
    frame.dispatchEvent(new Event("load"));
    const redirected = offerBridgePort(frame, "off-route-document");
    // Ready delivery is synchronous; closed offered endpoints prove denial,
    // rather than inferring it from an empty queue after an arbitrary delay.
    expect(redirected.closeActionPort).toHaveBeenCalledOnce();
    expect(redirected.closeDocumentPort).toHaveBeenCalledOnce();
    expect(redirected.postResponse).not.toHaveBeenCalled();
    redirected.parentPort.dispatchEvent(await queuedPortMessage(sessionAction("redirected-save")));
    expect(request).not.toHaveBeenCalled();
    expect(bridge.verifyDocument(vi.fn())).toBe(false);
  });

  it("rejects a repeated port offer without disrupting the connected document", async () => {
    const connected = await connectBridge();
    const repeated = offerBridgePort(connected.frame, "notes-nonce");
    expect(repeated.closeActionPort).toHaveBeenCalledOnce();
    expect(repeated.closeDocumentPort).toHaveBeenCalledOnce();
    expect(repeated.postResponse).not.toHaveBeenCalled();
    connected.childPort.postMessage(sessionAction("still-connected"));
    expect(await connected.responses.next()).toMatchObject({ id: "still-connected", ok: true });
    expect(connected.request).toHaveBeenCalledOnce();
  });

  it("revokes queued actions and in-flight replies when the active iframe navigates", async () => {
    const received = Promise.withResolvers<void>();
    const gatewayResult = Promise.withResolvers<{ ok: boolean }>();
    const request = vi.fn(() => {
      received.resolve();
      return gatewayResult.promise;
    });
    const connected = await connectBridge({ request });
    connected.childPort.postMessage(sessionAction("in-flight-save"));
    await received.promise;
    connected.postResponse.mockClear();
    connected.frame.dispatchEvent(new Event("load"));
    connected.frame.dispatchEvent(new Event("load"));
    expect(connected.closeActionPort).toHaveBeenCalledOnce();
    expect(connected.closeDocumentPort).toHaveBeenCalledOnce();
    // Deliver an already-queued callback even though close() blocks new tasks.
    connected.parentPort.dispatchEvent(await queuedPortMessage(sessionAction("retired-save")));
    const navigation = offerBridgePort(connected.frame, "notes-nonce");
    expect(navigation.closeActionPort).toHaveBeenCalledOnce();
    expect(navigation.closeDocumentPort).toHaveBeenCalledOnce();
    expect(navigation.postResponse).not.toHaveBeenCalled();
    gatewayResult.resolve({ ok: true });
    // The owner's await was registered before this fence; its reply continuation
    // has completed when this await resumes.
    await gatewayResult.promise;
    expect(request).toHaveBeenCalledOnce();
    expect(connected.postResponse).not.toHaveBeenCalled();
    expect(connected.bridge.verifyDocument(vi.fn())).toBe(false);
  });

  it.each([
    ["session", "agent:main:refreshed", 64_000],
    ["context window", "agent:main:active", 128_000],
  ])(
    "rejects the prior revision when the trusted %s changes",
    async (_name, sessionKey, contextTokens) => {
      const connected = await connectBridge();
      connected.bridge.sync({
        frame: connected.frame,
        key: "notes/settings",
        nonce: "notes-nonce",
        pluginId: "notes",
        client: { request: connected.request } as unknown as GatewayBrowserClient,
        connected: true,
        sessionKey,
        contextTokens,
        sessionActions: ["save"],
      });
      expect(await connected.responses.next()).toEqual({
        v: 1,
        type: "openclaw.pluginUi.update",
        capabilities: { sessionActions: ["save"] },
        context: { sessionKey, revision: 2, contextTokens },
      });
      connected.childPort.postMessage(sessionAction("save-stale"));
      expect(await connected.responses.next()).toMatchObject({
        id: "save-stale",
        ok: false,
        error: "Plugin UI session context is stale",
      });
      expect(connected.request).not.toHaveBeenCalled();
      connected.childPort.postMessage(sessionAction("save-refreshed", 2));
      expect(await connected.responses.next()).toMatchObject({ id: "save-refreshed", ok: true });
      expect(connected.request).toHaveBeenCalledExactlyOnceWith("plugins.sessionAction", {
        pluginId: "notes",
        actionId: "save",
        sessionKey,
      });
    },
  );

  it("retires the prior tab port before granting the replacement tab capabilities", async () => {
    const connected = await connectBridge();
    const replacementRequest = vi.fn(async () => ({ ok: true }));
    connected.bridge.sync({
      frame: connected.frame,
      key: "calendar/settings",
      nonce: "calendar-nonce",
      pluginId: "calendar",
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
      connected: true,
      sessionKey: "agent:main:replacement",
      sessionActions: ["save"],
    });
    expect(connected.closeActionPort).toHaveBeenCalledOnce();
    expect(connected.closeDocumentPort).toHaveBeenCalledOnce();
    connected.parentPort.dispatchEvent(await queuedPortMessage(sessionAction("retired-save")));
    expect(connected.request).not.toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
    const earlyReplacement = offerBridgePort(connected.frame, "calendar-nonce");
    expect(earlyReplacement.closeActionPort).toHaveBeenCalledOnce();
    expect(earlyReplacement.closeDocumentPort).toHaveBeenCalledOnce();
    expect(earlyReplacement.postResponse).not.toHaveBeenCalled();
    connected.frame.dispatchEvent(new Event("load"));
    const replacement = offerBridgePort(connected.frame, "calendar-nonce");
    expect(await replacement.responses.next()).toMatchObject({
      type: "openclaw.pluginUi.connect",
      capabilities: { sessionActions: ["save"] },
      context: { sessionKey: "agent:main:replacement", revision: 1 },
    });
    replacement.childPort.postMessage(sessionAction("replacement-save"));
    expect(await replacement.responses.next()).toMatchObject({ id: "replacement-save", ok: true });
    expect(replacementRequest).toHaveBeenCalledExactlyOnceWith("plugins.sessionAction", {
      pluginId: "calendar",
      actionId: "save",
      sessionKey: "agent:main:replacement",
    });
  });

  it("requires the newest private document proof and consumes it only once", async () => {
    const connected = await connectBridge();
    const superseded = vi.fn();
    const current = vi.fn();
    expect(connected.bridge.verifyDocument(superseded)).toBe(true);
    const first = (await connected.verifications.next()) as { id: unknown };
    expect(first).toMatchObject({ v: 1, type: "openclaw.pluginUi.verifyDocument" });
    expect(connected.bridge.verifyDocument(current)).toBe(true);
    const second = (await connected.verifications.next()) as { id: unknown };
    expect(second.id).not.toEqual(first.id);
    await deliverMessage(connected.childPort, connected.parentPort, acknowledgeDocument(second.id));
    expect(current).not.toHaveBeenCalled();
    await deliverMessage(
      connected.childDocumentPort,
      connected.parentDocumentPort,
      acknowledgeDocument(first.id),
    );
    expect(superseded).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    await deliverMessage(
      connected.childDocumentPort,
      connected.parentDocumentPort,
      acknowledgeDocument(second.id),
    );
    expect(current).toHaveBeenCalledOnce();
    await deliverMessage(
      connected.childDocumentPort,
      connected.parentDocumentPort,
      acknowledgeDocument(second.id),
    );
    expect(current).toHaveBeenCalledOnce();
    expect(superseded).not.toHaveBeenCalled();
  });

  it.each(["navigation", "replacement tab", "clear"])(
    "rejects a delayed document acknowledgment after %s",
    async (retirement) => {
      const connected = await connectBridge();
      const verified = vi.fn();
      expect(connected.bridge.verifyDocument(verified)).toBe(true);
      const proof = (await connected.verifications.next()) as { id: unknown };
      if (retirement === "navigation") {
        connected.frame.dispatchEvent(new Event("load"));
        connected.frame.dispatchEvent(new Event("load"));
      } else if (retirement === "replacement tab") {
        connected.bridge.sync({
          frame: connected.frame,
          key: "calendar/settings",
          nonce: "calendar-nonce",
          pluginId: "calendar",
          client: { request: connected.request } as unknown as GatewayBrowserClient,
          connected: true,
          sessionKey: "agent:main:replacement",
          sessionActions: ["save"],
        });
      } else {
        connected.bridge.clear();
      }
      expect(connected.closeDocumentPort).toHaveBeenCalledOnce();
      connected.parentDocumentPort.dispatchEvent(
        await queuedPortMessage(acknowledgeDocument(proof.id)),
      );
      expect(verified).not.toHaveBeenCalled();
      expect(connected.bridge.verifyDocument(vi.fn())).toBe(false);
    },
  );
});
