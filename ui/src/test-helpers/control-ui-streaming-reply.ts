/** A long synthetic answer whose fences, tables, and inline tokens cross delta boundaries. */
export function createControlUiStreamingReply() {
  const text = Array.from({ length: 24 }, (_, index) => {
    const section = index + 1;
    return `## Checkpoint ${section}\n\nThe streaming renderer should retain completed content while the next paragraph grows. This checkpoint includes **important details**, an [example link](https://example.com/checkpoint/${section}), and inline \`code\` without moving the surrounding conversation.\n\n\`\`\`typescript\nexport function checkpoint${section}(values: readonly number[]) {\n  return values.filter((value) => value < 100).map((value) => ({ value, doubled: value * 2 }));\n}\n\`\`\`\n\n| Measurement | Expected behavior |\n| --- | --- |\n| Completed blocks | Retain their DOM |\n| Open paragraph | Update in place |\n| Checkpoint | ${section} of 24 |\n\nThe result is ready for the next checkpoint.\n\n`;
  }).join("");
  // A deterministic variable chunk size avoids aligning deltas with Markdown block boundaries.
  const deltas: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    offset = Math.min(text.length, offset + 12 + ((deltas.length * 17) % 25));
    deltas.push(text.slice(0, offset));
  }
  return { text, deltas, deltasPerSecond: 30 };
}

export function createStreamingReplyProbeInitScript(): string {
  return `;(() => { const __name = (target) => target; (${installStreamingReplyProbe.toString()})(); })();`;
}

function installStreamingReplyProbe() {
  type Delta = {
    index: number;
    chars: number;
    at: number;
    taskAndMicrotasksMs?: number;
    parseCalls: number;
    parseChars: number;
    parseMs: number;
    geometryReads: number;
    styleReads: number;
  };
  let active = false;
  let startedAt = 0;
  let current: Delta | undefined;
  let finalReceived = false;
  const deltas: Delta[] = [];
  const frames: number[] = [];
  const inputs: Array<{ delayMs: number; nextFrameMs?: number; chars: number }> = [];
  const longFrames: Array<{ start: number; duration: number; blocking: number }> = [];
  const channel = new MessageChannel();
  const taskEnds: Array<{ delta: Delta; at: number }> = [];
  channel.port1.addEventListener("message", () => {
    const pending = taskEnds.shift();
    if (pending) {
      pending.delta.taskAndMicrotasksMs = performance.now() - pending.at;
    }
  });
  channel.port1.start();
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args) {
      const socket: WebSocket = Reflect.construct(target, args);
      socket.addEventListener("message", (event: MessageEvent) => {
        if (!active || typeof event.data !== "string") {
          return;
        }
        const frame = JSON.parse(event.data);
        if (frame.event !== "chat") {
          return;
        }
        const payload = frame.payload;
        if (payload?.state === "final") {
          finalReceived = true;
          return;
        }
        if (payload?.state !== "delta") {
          return;
        }
        current = {
          index: deltas.length + 1,
          chars: payload.message.content[0].text.length,
          at: performance.now() - startedAt,
          parseCalls: 0,
          parseChars: 0,
          parseMs: 0,
          geometryReads: 0,
          styleReads: 0,
        };
        deltas.push(current);
        taskEnds.push({ delta: current, at: performance.now() });
        channel.port2.postMessage(null);
      });
      return socket;
    },
  });
  const parserPrototype: {
    parseFromString: (this: DOMParser, source: string, type: DOMParserSupportedType) => Document;
  } = DOMParser.prototype;
  const parse = parserPrototype.parseFromString;
  DOMParser.prototype.parseFromString = function (this: DOMParser, source: unknown, type) {
    const start = performance.now();
    try {
      return Reflect.apply(parse, this, [source, type]);
    } finally {
      if (active && current) {
        current.parseCalls++;
        current.parseChars += String(source).length;
        current.parseMs += performance.now() - start;
      }
    }
  };
  const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...innerHTML,
    set(value: unknown) {
      const start = performance.now();
      try {
        innerHTML.set!.call(this, value);
      } finally {
        if (active && current && this instanceof HTMLTemplateElement) {
          current.parseCalls++;
          current.parseChars += String(value).length;
          current.parseMs += performance.now() - start;
        }
      }
    },
  });
  const elementPrototype: {
    getBoundingClientRect: (this: Element) => DOMRect;
  } = Element.prototype;
  const rect = elementPrototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (active && current) {
      current.geometryReads++;
    }
    return rect.call(this);
  };
  const style = window.getComputedStyle;
  window.getComputedStyle = (...args) => {
    if (active && current) {
      current.styleReads++;
    }
    return style.apply(window, args);
  };
  document.addEventListener("keydown", (event) => {
    if (!active || !event.isTrusted) {
      return;
    }
    const start = performance.now();
    const sample = { delayMs: Math.max(0, start - event.timeStamp), chars: current?.chars ?? 0 };
    inputs.push(sample);
    requestAnimationFrame(() => {
      Object.assign(sample, { nextFrameMs: performance.now() - event.timeStamp });
    });
  });
  new PerformanceObserver((list) => {
    if (!active) {
      return;
    }
    for (const entry of list.getEntries()) {
      const blocking = Reflect.get(entry, "blockingDuration");
      longFrames.push({
        start: entry.startTime - startedAt,
        duration: entry.duration,
        blocking: typeof blocking === "number" ? blocking : 0,
      });
    }
  }).observe({ type: "long-animation-frame", buffered: true });
  const frame = (at: number) => {
    if (!active) {
      return;
    }
    frames.push(at - startedAt);
    requestAnimationFrame(frame);
  };
  Reflect.set(window, "__streamingReply", {
    async start(input: {
      sessionKey: string;
      runId: string;
      deltas: string[];
      deltasPerSecond: number;
    }) {
      startedAt = performance.now();
      active = true;
      requestAnimationFrame(frame);
      const gateway = Reflect.get(window, "openclawControlUiE2eGateway");
      for (const [index, text] of input.deltas.entries()) {
        setTimeout(
          () => {
            gateway.emit("chat", {
              sessionKey: input.sessionKey,
              runId: input.runId,
              seq: index + 1,
              state: "delta",
              message: { role: "assistant", content: [{ type: "text", text }] },
            });
          },
          ((index + 1) * 1000) / input.deltasPerSecond,
        );
      }
    },
    read() {
      return { active, delivered: deltas.length, finalReceived };
    },
    finish() {
      active = false;
      if (deltas.some((delta) => !Number.isFinite(delta.parseChars))) {
        throw new Error("Streaming HTML probe produced a non-finite character count");
      }
      const sorted = (values: number[]) => values.toSorted((a, b) => a - b);
      const distribution = (values: number[]) => {
        const xs = sorted(values);
        const quantile = (q: number) => {
          const at = (xs.length - 1) * q;
          const lo = Math.floor(at);
          return xs.length ? xs[lo]! + (xs[Math.ceil(at)]! - xs[lo]!) * (at - lo) : 0;
        };
        return {
          median: quantile(0.5),
          p95: quantile(0.95),
          iqr: quantile(0.75) - quantile(0.25),
          max: xs.at(-1) ?? 0,
        };
      };
      const gaps = frames.slice(1).map((at, index) => at - frames[index]!);
      const buckets = Array.from({ length: 4 }, (_, index) => {
        const samples = deltas.slice(
          Math.floor((deltas.length * index) / 4),
          Math.floor((deltas.length * (index + 1)) / 4),
        );
        return {
          fromChars: samples[0]?.chars,
          toChars: samples.at(-1)?.chars,
          count: samples.length,
          taskAndMicrotasksMs: distribution(
            samples.flatMap((sample) =>
              sample.taskAndMicrotasksMs === undefined ? [] : [sample.taskAndMicrotasksMs],
            ),
          ),
          parseCalls: samples.reduce((sum, sample) => sum + sample.parseCalls, 0),
          parseChars: samples.reduce((sum, sample) => sum + sample.parseChars, 0),
          parseMs: samples.reduce((sum, sample) => sum + sample.parseMs, 0),
          geometryReads: samples.reduce((sum, sample) => sum + sample.geometryReads, 0),
          styleReads: samples.reduce((sum, sample) => sum + sample.styleReads, 0),
        };
      });
      return {
        measurement:
          "Untraced streaming only. Per-delta taskAndMicrotasksMs is delivery to a MessageChannel task (includes app microtasks and scheduling delay). Parse/geometry/style totals include asynchronous work until the next delta. Frame loss assumes 60 Hz; keydown samples are trusted native input to next rAF, not presentation timestamps.",
        startedAt,
        elapsedMs: performance.now() - startedAt,
        rig: {
          loaf: Reflect.get(window, "__perf")?.loaf?.filter(
            (entry: { start: number }) => entry.start >= startedAt,
          ),
          mutations: Object.fromEntries(Reflect.get(window, "__perf")?.mut ?? []),
          ws: Reflect.get(window, "__wsLog"),
        },
        deltas,
        buckets,
        frameGapsMs: distribution(gaps),
        estimatedDroppedFrames: gaps.reduce(
          (sum, gap) => sum + Math.max(0, Math.round(gap / (1000 / 60)) - 1),
          0,
        ),
        longFrames,
        longFrameBlockingMs: longFrames.reduce((sum, item) => sum + item.blocking, 0),
        inputs,
        inputDelayMs: distribution(inputs.map((sample) => sample.delayMs)),
        inputToNextFrameMs: distribution(
          inputs.flatMap((sample) =>
            sample.nextFrameMs === undefined ? [] : [sample.nextFrameMs],
          ),
        ),
        finalHtml: document.querySelector(".chat-bubble.streaming .chat-text")?.innerHTML ?? null,
      };
    },
  });
}
