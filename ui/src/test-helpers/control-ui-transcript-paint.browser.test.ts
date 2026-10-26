import { expect, it } from "vitest";
import { warmReloadProbe } from "../../../scripts/lib/control-ui-warm-reload-probe.ts";

it.for([
  {
    method: "chat.startup",
    params: {},
    payload: { messages: [] },
    catchesUp: true,
    kind: "window",
  },
  {
    method: "sessions.messages.subscribe",
    params: {},
    payload: { key: "agent:main:main" },
    catchesUp: false,
    kind: undefined,
  },
  {
    method: "sessions.messages.subscribe",
    params: { initialHistory: {} },
    payload: { initialHistory: { ok: true, payload: { messages: [] } } },
    catchesUp: true,
    kind: "window",
  },
  {
    method: "sessions.messages.subscribe",
    params: { initialHistory: { cursor: "cached-cursor" } },
    payload: { initialHistory: { ok: true, payload: { kind: "delta", messages: [] } } },
    catchesUp: true,
    kind: "delta",
  },
  {
    method: "sessions.messages.subscribe",
    params: { initialHistory: { cursor: "stale-cursor" } },
    payload: { initialHistory: { ok: true, payload: { kind: "reset" } } },
    catchesUp: true,
    kind: "reset",
  },
])("records catch-up only when $method returns history ($catchesUp)", async (scenario) => {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  try {
    const target = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!target || !doc) {
      throw new Error("Paint probe realm was not created");
    }
    const script = doc.createElement("script");
    script.textContent = `
      const __name = fn => fn;
      window.WebSocket = class extends EventTarget { send() {} };
      (${warmReloadProbe.toString()})();
      const socket = new WebSocket();
      socket.send(JSON.stringify({type: 'req', id: 'history', method: ${JSON.stringify(scenario.method)}, params: ${JSON.stringify(scenario.params)}}));
      socket.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({
        type: 'res', id: 'history', ok: true, payload: ${JSON.stringify(scenario.payload)}
      })}));
    `;
    doc.body.append(script);
    const proof = Reflect.get(target, "__warmReload").read();
    const milestone = proof.milestones.catchupResponse;
    expect(typeof milestone === "number").toBe(scenario.catchesUp);
    expect(proof.historyRequests).toHaveLength(scenario.catchesUp ? 1 : 0);
    if (scenario.catchesUp) {
      const response = JSON.stringify({
        type: "res",
        id: "history",
        ok: true,
        payload: scenario.payload,
      });
      expect(proof.historyRequests[0]).toMatchObject({
        method: scenario.method,
        cursor: Boolean(scenario.params.initialHistory?.cursor),
        kind: scenario.kind,
        responseBytes: new Blob([response]).size,
      });
    }
  } finally {
    iframe.remove();
  }
});

it("records transcript presentation after opacity reveals nested text, not its earlier DOM mount", async () => {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  try {
    const target = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!target || !doc) {
      throw new Error("Paint probe realm was not created");
    }
    const script = doc.createElement("script");
    script.textContent = `
      const __name = fn => fn;
      (${warmReloadProbe.toString()})();
      document.body.innerHTML += '<div class="chat-pane-cache__pane--active" style="opacity:0"><div class="chat-thread"><div class="chat-thread-inner"><div class="chat-virtual-row" data-virtual-row-key="fixture-row"><div class="chat-text"><p>Cached transcript text.</p></div></div></div></div></div>';
      window.paintProof = new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const shownAt = performance.now();
          const painted = new PerformanceObserver(list => {
            if (!list.getEntries().some(entry => entry.identifier === 'openclaw-transcript')) return;
            painted.disconnect();
            resolve({ shownAt, ...window.__warmReload.read() });
          });
          painted.observe({ type:'element', buffered:true });
          document.querySelector('.chat-pane-cache__pane--active').style.opacity = '1';
        }));
      });
    `;
    doc.body.append(script);
    const proof = await Reflect.get(target, "paintProof");
    expect(proof.transcriptPaints).toContainEqual({
      element: "p",
      rowKey: "fixture-row",
      renderTime: proof.milestones.firstTranscriptPaint,
    });
    expect(proof.milestones.firstTranscriptPaint).toBeGreaterThanOrEqual(proof.shownAt);
    expect(proof.milestones.firstTranscript).toBeLessThanOrEqual(proof.shownAt);
  } finally {
    iframe.remove();
  }
});

it.for(["hidden", "clipped", "animated"] as const)(
  "distinguishes %s transcript paintability from an actual Element Timing entry",
  async (layout) => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Paint probe realm was not created");
      }
      const script = doc.createElement("script");
      script.textContent = `
        const __name = fn => fn;
        (${warmReloadProbe.toString()})();
        const layout = ${JSON.stringify(layout)};
        const style = document.createElement('style');
        style.textContent = '.fixture-layout { opacity:1; transition:opacity 60ms linear; @starting-style { opacity:0; } }';
        document.head.append(style);
        const pane = document.createElement('div');
        pane.className = 'chat-pane-cache__pane--active' + (layout === 'animated' ? ' fixture-layout' : '');
        if (layout === 'hidden') pane.style.opacity = '0';
        pane.innerHTML = '<div class="chat-thread" style="height:' + (layout === 'clipped' ? '0' : '100') + 'px;overflow:hidden"><div class="chat-thread-inner"><div class="chat-virtual-row" data-virtual-row-key="fixture-row"><div class="chat-text"><p>Cached transcript text.</p></div></div></div></div>';
        document.body.append(pane);
        window.paintProof = (async () => {
          await new Promise(requestAnimationFrame);
          await Promise.all(pane.getAnimations().map(animation => animation.finished));
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return window.__warmReload.read();
        })();
      `;
      doc.body.append(script);
      const proof = await Reflect.get(target, "paintProof");
      expect(proof.transcriptPresentation).toMatchObject({
        paintable: layout === "animated",
        textRoots: 1,
        taggedTextOwners: 1,
      });
      if (layout === "animated") {
        expect(["measured", "visible-without-element-timing"]).toContain(
          proof.transcriptPresentation.status,
        );
        expect(typeof proof.milestones.firstTranscriptPaint === "number").toBe(
          proof.transcriptPresentation.status === "measured",
        );
      } else {
        expect(proof.transcriptPresentation.status).toBe("hidden-or-clipped");
        expect(proof.milestones.firstTranscriptPaint).toBeUndefined();
      }
    } finally {
      iframe.remove();
    }
  },
);
