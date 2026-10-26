import { expect, it } from "vitest";
import { warmReloadProbe } from "../../../scripts/lib/control-ui-warm-reload-probe.ts";

it.for([
  { method: "chat.startup", payload: { messages: [] }, catchesUp: true },
  { method: "sessions.messages.subscribe", payload: { key: "agent:main:main" }, catchesUp: false },
  {
    method: "sessions.messages.subscribe",
    payload: { initialHistory: { ok: true, payload: { messages: [] } } },
    catchesUp: true,
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
      socket.send(JSON.stringify({type: 'req', id: 'history', method: ${JSON.stringify(scenario.method)}}));
      socket.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({
        type: 'res', id: 'history', ok: true, payload: ${JSON.stringify(scenario.payload)}
      })}));
    `;
    doc.body.append(script);
    const milestone = Reflect.get(target, "__warmReload").read().milestones.catchupResponse;
    expect(typeof milestone === "number").toBe(scenario.catchesUp);
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
