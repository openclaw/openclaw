import { describe, expect, it } from "vitest";
import { createColdLoadProbeInitScript } from "./control-ui-cold-load-probes.ts";

describe("serialized cold-load probes", () => {
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
          requestUpdate() { return this; }, prepareRender() { return this; }, commitRender() { return this; }
        };
        if (${ownerProbes}) map.set(sidebar, owner);
        const pageOwner = {
          host: page, isConnected: true,
          requestUpdate() { return this; }, performUpdate() { return this; }, render() { return this; }, afterCommit() { return this; }
        };
        if (${ownerProbes}) map.set(page, pageOwner);
        const paneOwner = {
          element: pane, isConnected: true,
          requestUpdate() { return this; }, performUpdate() { return this; }, render() { return this; },
          prepareRender() { return this; }, commitRender() { return this; }
        };
        if (${ownerProbes}) map.set(pane, paneOwner);
        const restoredAfterCapture = WeakMap === NativeWeakMap && map.set === nativeSet;
        __coldLoad.startLive();
        const receiverPreserved = owner.requestUpdate() === owner &&
          owner.sessionData.requestSessionDataUpdate() === owner.sessionData &&
          pageOwner.requestUpdate() === pageOwner && paneOwner.requestUpdate() === paneOwner;
        owner.prepareRender(); owner.commitRender();
        pageOwner.performUpdate(); pageOwner.render();
        paneOwner.performUpdate(); paneOwner.render();
        globalThis.probeDone = new Promise(resolve => {
          requestAnimationFrame(() => {
            const live = __coldLoad.readLive();
            __coldLoad.finishLive();
            resolve({
              nativeUntouched, restoredAfterCapture, receiverPreserved,
              nativeRestored: WeakMap === NativeWeakMap && NativeWeakMap.prototype.set === nativeSet && requestAnimationFrame === nativeFrame,
              storedOwner: ${ownerProbes} ? map.get(sidebar) === owner : !map.has(sidebar),
              ownerProbes: live.ownerProbes,
              sidebarMethods: live.solidSidebar?.passes.map(pass => pass.method) ?? [],
              chatPasses: live.solidChat?.passes.map(pass => pass.tag) ?? [],
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
        storedOwner: true,
        ownerProbes,
        sidebarMethods: ownerProbes ? ["requestUpdate", "prepareRender", "commitRender"] : [],
        chatPasses: ownerProbes ? ["openclaw-chat-page", "openclaw-chat-pane"] : [],
        frameCount: ownerProbes ? 1 : 0,
      });
    } finally {
      iframe.remove();
    }
  });
});
