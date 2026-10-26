import { describe, expect, it } from "vitest";
import { resolveColdLoadLatency } from "../../../scripts/lib/control-ui-bench-latency.ts";
import { createColdLoadProbeInitScript } from "./control-ui-cold-load-probes.ts";

describe("serialized cold-load probes", () => {
  it("preserves event order in separate tasks when timers wake out of order", () => {
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
        Object.defineProperty(performance, "now", { value: () => 0 });
        const timers = [];
        window.setTimeout = (callback, delay) => { timers.push({callback, delay}); return timers.length; };
        window.WebSocket = class extends EventTarget { send() {} };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 0, frameGapMs: 0, methodLatencyMs: { "delayed.read": 1000 }, events: [] })}
        const socket = new WebSocket();
        const delivered = [];
        let task = 0;
        socket.addEventListener("message", event => {
          const frame = JSON.parse(event.data);
          delivered.push({ value: frame.seq ?? frame.id, task });
        });
        const response = (id, method) => {
          socket.send(JSON.stringify({type: "req", id, method}));
          socket.dispatchEvent(new MessageEvent("message", {data: JSON.stringify({type: "res", id, ok: true, payload: {}})}));
        };
        response("slow", "delayed.read");
        for (const seq of [1, 2, 3]) {
          socket.dispatchEvent(new MessageEvent("message", {data: JSON.stringify({type: "event", event: "example", seq, payload: {}})}));
        }
        response("fast", "fast.read");
        const scheduled = timers.splice(0);
        const run = timer => { task++; timer.callback(); };
        run(scheduled[2]);
        run(scheduled[3]);
        const beforeFirst = delivered.length;
        run(scheduled[4]);
        run(scheduled[1]);
        while (timers.length) run(timers.shift());
        const beforeSlow = delivered.map(entry => entry.value);
        run(scheduled[0]);
        window.eventOrderProof = {
          beforeFirst, beforeSlow, delivered,
          responseDelays: [scheduled[0].delay, scheduled[4].delay]
        };
      `;
      doc.body.append(script);
      const proof = Reflect.get(target, "eventOrderProof");
      expect(proof.beforeFirst).toBe(0);
      expect(proof.beforeSlow).toEqual(["fast", 1, 2, 3]);
      expect(proof.delivered.map((entry: { value: number | string }) => entry.value)).toEqual([
        "fast",
        1,
        2,
        3,
        "slow",
      ]);
      expect(new Set(proof.delivered.map((entry: { task: number }) => entry.task)).size).toBe(5);
      expect(proof.responseDelays).toEqual([1000, 0]);
    } finally {
      iframe.remove();
    }
  });

  it.each([
    8,
    resolveColdLoadLatency({
      profile: "live-capped",
      methodLatencyMs: [],
      sidebarQueryLatencyMs: [],
    }).downloadKbps,
  ])("serializes ready reply bytes on the %i Kbit/s download link", (downloadKbps) => {
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
        Object.defineProperty(performance, "now", { value: () => 0 });
        const timers = [];
        window.setTimeout = (callback, delay) => { timers.push({callback, delay}); return timers.length; };
        window.WebSocket = class extends EventTarget { send() {} };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 100, downloadKbps, frameGapMs: 0, events: [] })}
        const socket = new WebSocket();
        let delivered = 0;
        socket.addEventListener("message", () => delivered++);
        const data = JSON.stringify({type: "event", event: "example", payload: "é"});
        socket.dispatchEvent(new MessageEvent("message", {data}));
        socket.dispatchEvent(new MessageEvent("message", {data}));
        const eligibility = timers.splice(0);
        eligibility.forEach(timer => timer.callback());
        const delivery = timers.splice(0);
        const before = delivered;
        delivery.forEach(timer => timer.callback());
        window.downloadProof = {
          eligibility: eligibility.map(timer => timer.delay),
          delivery: delivery.map(timer => timer.delay),
          bytes: new TextEncoder().encode(data).length,
          before, delivered
        };
      `;
      doc.body.append(script);
      const proof = Reflect.get(target, "downloadProof");
      expect(proof.eligibility).toEqual([100, 100]);
      const transferMs = (proof.bytes * 8) / downloadKbps;
      expect(proof.delivery).toEqual([transferMs, transferMs * 2]);
      expect(proof.before).toBe(0);
      expect(proof.delivered).toBe(2);
    } finally {
      iframe.remove();
    }
  });

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

  it("records history response outcomes without retaining or changing response bodies", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Probe realm was not created");
      }
      const responses = [
        { method: "chat.startup", ok: true, payload: { messages: ["synthetic"] } },
        { method: "chat.history", ok: false, error: { message: "Synthetic failure" } },
        {
          method: "sessions.messages.subscribe",
          ok: true,
          payload: { initialHistory: { ok: true } },
        },
        {
          method: "sessions.messages.subscribe",
          ok: true,
          payload: { initialHistory: { ok: false } },
        },
        {
          method: "sessions.messages.subscribe",
          ok: false,
          error: { message: "Synthetic failure" },
        },
      ];
      const script = doc.createElement("script");
      script.textContent = `
        const timers = [];
        window.setTimeout = callback => { timers.push(callback); return timers.length; };
        window.WebSocket = class extends EventTarget { send() {} };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 0, frameGapMs: 0, events: [] })}
        const socket = new WebSocket();
        const delivered = [];
        socket.addEventListener("message", event => delivered.push(JSON.parse(event.data)));
        const sent = ${JSON.stringify(responses)}.map(({method, ...response}, index) => {
          const id = String(index);
          socket.send(JSON.stringify({type: "req", id, method, params: {sessionKey: "synthetic-session"}}));
          const frame = {type: "res", id, ...response};
          socket.dispatchEvent(new MessageEvent("message", {data: JSON.stringify(frame)}));
          return frame;
        });
        while (timers.length) timers.shift()();
        window.historyResponseProof = {sent, delivered, rpcs: __coldLoad.read().rpcs};
      `;
      doc.body.append(script);
      const proof = Reflect.get(target, "historyResponseProof");
      expect(proof.delivered).toEqual(proof.sent);
      expect(
        proof.rpcs.map((rpc: Record<string, unknown>) => ({
          responseOk: rpc.responseOk,
          initialHistoryOk: rpc.initialHistoryOk,
        })),
      ).toEqual([
        { responseOk: true, initialHistoryOk: undefined },
        { responseOk: false, initialHistoryOk: undefined },
        { responseOk: true, initialHistoryOk: true },
        { responseOk: true, initialHistoryOk: false },
        { responseOk: false, initialHistoryOk: undefined },
      ]);
      for (const rpc of proof.rpcs) {
        expect(rpc).not.toHaveProperty("payload");
        expect(rpc).not.toHaveProperty("error");
      }
    } finally {
      iframe.remove();
    }
  });

  it("holds the challenge until connect can leave without an intercepted send", () => {
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
        const timers = [];
        window.setTimeout = (callback, delay) => { timers.push({callback, delay}); return timers.length; };
        const sent = [];
        window.WebSocket = class extends EventTarget { send(data) { sent.push(JSON.parse(data).method); } };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 0, frameGapMs: 0, connectNotBeforeMs: 1e9, events: [] })}
        const socket = new WebSocket();
        let challenges = 0;
        socket.addEventListener("message", () => {
          challenges++;
          socket.send(JSON.stringify({type: "req", id: "connect", method: "connect"}));
        });
        socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({type: "event", event: "connect.challenge", payload: {nonce: "synthetic"}}) }));
        const before = { challenges, sent: [...sent] };
        const timer = timers.shift();
        timer.callback();
        window.connectDispatchProof = { before, challenges, sent, delayed: timer.delay > 0, pendingTimers: timers.length };
      `;
      doc.body.append(script);
      expect(Reflect.get(target, "connectDispatchProof")).toEqual({
        before: { challenges: 0, sent: [] },
        challenges: 1,
        sent: ["connect"],
        delayed: true,
        pendingTimers: 0,
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
