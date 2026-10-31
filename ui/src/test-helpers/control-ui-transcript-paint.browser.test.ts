import { expect, it } from "vitest";
import { warmReloadProbe } from "../../../scripts/lib/control-ui-warm-reload-probe.ts";

async function runProbe(source: string, setup = "") {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  try {
    const target = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!target || !doc) {
      throw new Error("Paint probe realm was not created");
    }
    const script = doc.createElement("script");
    script.textContent = `const __name = fn => fn; ${setup}; (${warmReloadProbe.toString()})(); ${source}`;
    doc.body.append(script);
    return await Reflect.get(target, "probeResult");
  } finally {
    iframe.remove();
  }
}

it.for([
  {
    method: "chat.startup",
    payload: { messages: [] },
    catchesUp: true,
    kind: "window",
  },
  {
    method: "sessions.messages.subscribe",
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
  const proof = await runProbe(
    `
      const socket = new WebSocket();
      socket.send(JSON.stringify({type: 'req', id: 'history', method: ${JSON.stringify(scenario.method)}, params: ${JSON.stringify(scenario.params ?? {})}}));
      socket.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({
        type: 'res', id: 'history', ok: true, payload: ${JSON.stringify(scenario.payload)}
      })}));
      window.probeResult = window.__warmReload.read();
    `,
    "window.WebSocket = class extends EventTarget { send() {} };",
  );
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
      cursor: Boolean(scenario.params?.initialHistory?.cursor),
      kind: scenario.kind,
      responseBytes: new Blob([response]).size,
    });
  }
});

it("records live transcript visibility after caught-up rows are revealed", async () => {
  const proof = await runProbe(`
      const pane = document.createElement('div');
      pane.className = 'chat-pane-cache__pane--active';
      pane.innerHTML = '<div class="chat-thread"><div class="chat-thread-inner"><div class="chat-virtual-row" data-virtual-row-key="fixture-row"><div class="chat-text"><p>Transcript text.</p></div></div></div></div>';
      document.body.append(pane);
      const inner = pane.querySelector('.chat-thread-inner');
      window.probeResult = (async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const caughtUpAt = performance.now();
        inner.style.visibility = 'hidden';
        pane.transcriptReady = true;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const shownAt = performance.now();
        inner.style.visibility = 'visible';
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return { caughtUpAt, shownAt, ...window.__warmReload.read() };
      })();
  `);
  expect(proof.milestones.firstTranscript).toBeLessThanOrEqual(proof.caughtUpAt);
  expect(proof.milestones.catchupApplied).toBeGreaterThanOrEqual(proof.caughtUpAt);
  expect(proof.milestones.catchupApplied).toBeLessThan(proof.shownAt);
  expect(proof.milestones.firstLiveTranscript).toBeGreaterThanOrEqual(proof.shownAt);
});

it("records transcript presentation after opacity reveals nested text, not its earlier DOM mount", async () => {
  const proof = await runProbe(`
      document.body.innerHTML += '<div class="chat-pane-cache__pane--active" style="opacity:0"><div class="chat-thread"><div class="chat-thread-inner"><div class="chat-virtual-row" data-virtual-row-key="fixture-row"><div class="chat-text"><p>Cached transcript text.</p></div></div></div></div></div>';
      window.probeResult = new Promise(resolve => {
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
  `);
  expect(proof.transcriptPaints).toContainEqual({
    element: "p",
    rowKey: "fixture-row",
    renderTime: proof.milestones.firstTranscriptPaint,
  });
  expect(proof.milestones.firstTranscriptPaint).toBeGreaterThanOrEqual(proof.shownAt);
  expect(proof.milestones.firstTranscript).toBeLessThanOrEqual(proof.shownAt);
});

it.for(["hidden", "clipped", "animated"] as const)(
  "distinguishes %s transcript paintability from an actual Element Timing entry",
  async (layout) => {
    const proof = await runProbe(`
        const layout = ${JSON.stringify(layout)};
        const style = document.createElement('style');
        style.textContent = '.fixture-layout { opacity:1; transition:opacity 60ms linear; @starting-style { opacity:0; } }';
        document.head.append(style);
        const pane = document.createElement('div');
        pane.className = 'chat-pane-cache__pane--active' + (layout === 'animated' ? ' fixture-layout' : '');
        if (layout === 'hidden') pane.style.opacity = '0';
        pane.innerHTML = '<div class="chat-thread" style="height:' + (layout === 'clipped' ? '0' : '100') + 'px;overflow:hidden"><div class="chat-thread-inner"><div class="chat-virtual-row" data-virtual-row-key="fixture-row"><div class="chat-text"><p>Cached transcript text.</p></div></div></div></div>';
        document.body.append(pane);
        window.probeResult = (async () => {
          await new Promise(requestAnimationFrame);
          await Promise.all(pane.getAnimations().map(animation => animation.finished));
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return window.__warmReload.read();
        })();
    `);
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
  },
);

it("keeps missing, hidden, saved and live transcript witness paints distinct", async () => {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  try {
    const target = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!target || !doc) {
      throw new Error("Paint witness realm was not created");
    }
    const witnesses = {
      saved: { messageId: "cached", rowKey: "saved-row", text: "Saved witness text." },
      live: { messageId: "latest", rowKey: "live-row", text: "Fresh witness text." },
    };
    const script = doc.createElement("script");
    script.textContent = `
      const __name = fn => fn;
      (${warmReloadProbe.toString()})({ witnesses: ${JSON.stringify(witnesses)} });
      const pane = document.createElement('div');
      pane.className = 'chat-pane-cache__pane--active';
      document.body.append(pane);
      const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const paint = identifier => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Missing paint: ' + identifier)); }, 3000);
        const observer = new PerformanceObserver(list => {
          if (!list.getEntries().some(entry => entry.identifier === identifier && entry.renderTime > 0)) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        });
        observer.observe({ type: 'element', buffered: true });
      });
      const add = (key, text, hidden = false) => {
        const row = document.createElement('div');
        row.className = 'chat-virtual-row';
        row.dataset.virtualRowKey = key;
        row.style.opacity = hidden ? '0' : '1';
        const root = document.createElement('div');
        root.className = 'chat-text';
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        root.append(paragraph);
        row.append(root);
        pane.append(row);
        return row;
      };
      window.paintProof = (async () => {
        // Matching text in another row is not provenance.
        const unrelated = add('other-row', 'Saved witness text.');
        await paint('openclaw-transcript');
        const missing = window.__warmReload.witnesses();
        unrelated.dataset.virtualRowKey = 'saved-row';
        await frames();
        const alreadyPainted = window.__warmReload.witnesses();
        unrelated.remove();
        const saved = add('saved-row', 'Saved witness text.', true);
        await frames();
        const hiddenSaved = window.__warmReload.witnesses();
        const savedShownAt = performance.now();
        saved.style.opacity = '1';
        await paint('openclaw-transcript-saved');
        const savedPaint = window.__warmReload.witnesses();
        saved.remove();
        const live = add('live-row', 'Fresh witness text.', true);
        await frames();
        const hiddenLive = window.__warmReload.witnesses();
        const liveShownAt = performance.now();
        live.style.opacity = '1';
        await paint('openclaw-transcript-live');
        return { missing, alreadyPainted, hiddenSaved, savedShownAt, savedPaint, hiddenLive, liveShownAt, final: window.__warmReload.read() };
      })();
    `;
    doc.body.append(script);
    const proof = await Reflect.get(target, "paintProof");
    expect(proof.missing.saved).toEqual({ domMs: null, paintMs: null });
    expect(proof.missing.live).toEqual({ domMs: null, paintMs: null });
    expect(proof.alreadyPainted.saved.paintMs).toBeNull();
    expect(proof.hiddenSaved.saved.domMs).toBeTypeOf("number");
    expect(proof.hiddenSaved.saved.paintMs).toBeNull();
    expect(proof.savedPaint.saved.paintMs).toBeGreaterThanOrEqual(proof.savedShownAt);
    expect(proof.savedPaint.live.paintMs).toBeNull();
    expect(proof.hiddenLive.live.domMs).toBeTypeOf("number");
    expect(proof.hiddenLive.live.paintMs).toBeNull();
    expect(proof.final.transcriptWitnesses.live.paintMs).toBeGreaterThanOrEqual(proof.liveShownAt);
    expect(proof.final.transcriptWitnesses.saved.paintMs).toBe(proof.savedPaint.saved.paintMs);
    expect(proof.final.transcriptWitnesses.attached).toEqual({ saved: false, live: true });
    expect(proof.final.transcriptWitnesses.paints).toContainEqual({
      source: "saved",
      identifier: "openclaw-transcript-saved",
      rowKey: "saved-row",
      renderTime: proof.savedPaint.saved.paintMs,
    });
    expect(proof.final.transcriptWitnesses.paints).toContainEqual({
      source: "live",
      identifier: "openclaw-transcript-live",
      rowKey: "live-row",
      renderTime: proof.final.transcriptWitnesses.live.paintMs,
    });
  } finally {
    iframe.remove();
  }
});
