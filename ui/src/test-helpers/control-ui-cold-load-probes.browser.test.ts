import { describe, expect, it } from "vitest";
import { createColdLoadProbeInitScript } from "./control-ui-cold-load-probes.ts";

describe("serialized cold-load probes", () => {
  it("retires closed-socket requests without losing their RPC count or another socket's work", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Probe realm was not created");
      }
      const script = doc.createElement("script");
      script.textContent = `
        window.WebSocket = class extends EventTarget { send() {} };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 0, frameGapMs: 0, events: [] })}
        const oldSocket = new WebSocket();
        const currentSocket = new WebSocket();
        oldSocket.send(JSON.stringify({type: "req", id: "old", method: "sessions.list"}));
        currentSocket.send(JSON.stringify({type: "req", id: "current", method: "chat.startup"}));
        oldSocket.dispatchEvent(new Event("close"));
        const afterFirst = __coldLoad.read();
        const first = { pending: afterFirst.pendingMethods, rpcs: afterFirst.rpcs.map(rpc => ({ method: rpc.method, abandoned: rpc.abandoned })) };
        currentSocket.dispatchEvent(new Event("close"));
        const afterSecond = __coldLoad.read();
        window.closedSocketProof = { first, pending: afterSecond.pending, rpcs: afterSecond.rpcs.length };
      `;
      doc.body.append(script);
      expect(Reflect.get(target, "closedSocketProof")).toEqual({
        first: { pending: ["chat.startup"], rpcs: [{ method: "sessions.list", abandoned: true }] },
        pending: 0,
        rpcs: 2,
      });
    } finally {
      iframe.remove();
    }
  });

  it.each([true, false])("restores instrumentation with owner probes %s", async (ownerProbes) => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Probe realm was not created");
      }
      const script = doc.createElement("script");
      script.textContent = `
        const NativeWeakMap = WeakMap;
        const nativeSet = NativeWeakMap.prototype.set;
        const nativeFrame = requestAnimationFrame;
        ${createColdLoadProbeInitScript({ ownerProbes, latencyMs: 0, frameGapMs: 0, events: [] })}
        const nativeUntouched = NativeWeakMap.prototype.set === nativeSet;
        const map = new WeakMap([[{}, "iterable"]]);
        const sidebar = document.createElement("openclaw-app-sidebar");
        const page = document.createElement("openclaw-chat-page");
        const pane = document.createElement("openclaw-chat-pane");
        document.body.append(sidebar, page, pane);
        const owner = {
          hostElement: sidebar, isConnected: true,
          sessionData: { requestSessionDataUpdate() { return this; } },
          shouldPublishSessionData() { return true; },
          invalidate() { return this; }, prepareRender() { return this; }, commitRender() { return this; },
          releaseSidebarSnapshot() {}
        };
        const originalPublicationGate = owner.shouldPublishSessionData;
        if (${ownerProbes}) map.set(sidebar, owner);
        const paneOwner = {
          element: pane, isConnected: true,
          render() { return this; }
        };
        const originalRender = paneOwner.render;
        if (${ownerProbes}) map.set(pane, paneOwner);
        const restoredAfterCapture = WeakMap === NativeWeakMap && map.set === nativeSet;
        __coldLoad.startLive();
        const receiverPreserved = owner.invalidate() === owner &&
          owner.sessionData.requestSessionDataUpdate() === owner.sessionData &&
          paneOwner.render() === paneOwner;
        owner.prepareRender(); owner.commitRender();
        globalThis.openclawRenderLifecycleTestHook?.(paneOwner, "invalidate");
        paneOwner.render();
        globalThis.openclawRenderLifecycleTestHook?.(pane, "commit");
        globalThis.probeDone = new Promise(resolve => {
          requestAnimationFrame(() => {
            const live = __coldLoad.readLive();
            __coldLoad.finishLive();
            resolve({
              nativeUntouched, restoredAfterCapture, receiverPreserved,
              nativeRestored: WeakMap === NativeWeakMap && NativeWeakMap.prototype.set === nativeSet && requestAnimationFrame === nativeFrame,
              renderRestored: paneOwner.render === originalRender,
              publicationGateRestored: owner.shouldPublishSessionData === originalPublicationGate,
              storedOwner: ${ownerProbes} ? map.get(sidebar) === owner : !map.has(sidebar),
              ownerProbes: live.ownerProbes,
              sidebarMethods: live.solidSidebar?.passes.map(pass => pass.method) ?? [],
              chatPasses: live.solidChat?.passes.map(pass => pass.tag) ?? [],
              chatRequests: Object.keys(live.solidChat?.requests ?? {}).length,
              unmeasured: live.solidChat?.unmeasured ?? [],
              frameCount: Object.keys(live.solidChat?.frameOrigins ?? {}).length,
            });
          });
        });
      `;
      doc.body.append(script);
      expect(await Reflect.get(target, "probeDone")).toEqual({
        nativeUntouched: true,
        restoredAfterCapture: true,
        receiverPreserved: true,
        nativeRestored: true,
        renderRestored: true,
        publicationGateRestored: true,
        storedOwner: true,
        ownerProbes,
        sidebarMethods: ownerProbes ? ["invalidate", "prepareRender", "commitRender"] : [],
        chatPasses: ownerProbes ? ["openclaw-chat-pane", "openclaw-chat-pane"] : [],
        chatRequests: ownerProbes ? 1 : 0,
        unmeasured: ownerProbes
          ? ["page snapshot computations", "fine-grained Solid bindings"]
          : [],
        frameCount: ownerProbes ? 1 : 0,
      });
    } finally {
      iframe.remove();
    }
  });
});
