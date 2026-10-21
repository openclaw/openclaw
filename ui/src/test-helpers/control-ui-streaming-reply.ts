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
  const emptyCounters = {
    parseCalls: 0,
    parseChars: 0,
    parseMs: 0,
    geometryReads: 0,
    styleReads: 0,
  };
  type Delta = typeof emptyCounters & {
    index: number;
    chars: number;
    at: number;
    taskAndMicrotasksMs?: number;
  };
  let active = false;
  let startedAt = 0;
  let current: Delta | undefined;
  let finalReceived = false;
  let initialScrollHeight = 0;
  const pipeline = {
    streamWrites: 0,
    streamWriteMs: 0,
    publications: 0,
    paneRenders: 0,
    paneRenderMs: 0,
    railObservations: 0,
    rowResizeDeliveries: 0,
  };
  // Observe existing owners from their registration, without a production probe seam.
  const OriginalWeakMap = window.WeakMap;
  class ProbeWeakMap<K extends WeakKey, V> extends OriginalWeakMap<K, V> {
    override set(host: K, owner: V): this {
      super.set(host, owner);
      if (typeof owner !== "object" || owner === null) {
        return this;
      }
      const fields = Reflect.get(owner, "fields");
      const subscribe = Reflect.get(owner, "subscribe");
      if (
        Array.isArray(fields) &&
        fields.includes("chatStream") &&
        typeof subscribe === "function"
      ) {
        Reflect.apply(subscribe, owner, [() => active && pipeline.publications++]);
        const descriptor = Object.getOwnPropertyDescriptor(host, "chatStream");
        if (descriptor?.set) {
          Object.defineProperty(host, "chatStream", {
            ...descriptor,
            set(value: unknown) {
              const start = performance.now();
              descriptor.set?.call(this, value);
              if (active) {
                pipeline.streamWrites++;
                pipeline.streamWriteMs += performance.now() - start;
              }
            },
          });
        }
      }
      const render = Reflect.get(owner, "render");
      if (
        host instanceof HTMLElement &&
        host.localName === "openclaw-chat-pane" &&
        typeof render === "function"
      ) {
        Reflect.set(owner, "render", function (this: object, ...args: unknown[]) {
          const start = performance.now();
          try {
            return Reflect.apply(render, this, args);
          } finally {
            if (active) {
              pipeline.paneRenders++;
              pipeline.paneRenderMs += performance.now() - start;
            }
          }
        });
      }
      return this;
    }
  }
  window.WeakMap = ProbeWeakMap;
  const OriginalResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends OriginalResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        if (active) {
          pipeline.rowResizeDeliveries += entries.filter((entry) =>
            entry.target.classList.contains("chat-virtual-row"),
          ).length;
        }
        callback(entries, observer);
      });
    }
    override observe(target: Element, options?: ResizeObserverOptions) {
      if (active && target.classList.contains("chat-position-rail__marks")) {
        pipeline.railObservations++;
      }
      super.observe(target, options);
    }
  };
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
          ...emptyCounters,
        };
        deltas.push(current);
        taskEnds.push({ delta: current, at: performance.now() });
        channel.port2.postMessage(null);
      });
      return socket;
    },
  });
  const measureParse = <T>(source: unknown, parse: () => T): T => {
    const start = performance.now();
    try {
      return parse();
    } finally {
      if (active && current) {
        current.parseCalls++;
        current.parseChars += String(source).length;
        current.parseMs += performance.now() - start;
      }
    }
  };
  const parserPrototype: {
    parseFromString: (this: DOMParser, source: string, type: DOMParserSupportedType) => Document;
  } = DOMParser.prototype;
  const parse = parserPrototype.parseFromString;
  DOMParser.prototype.parseFromString = function (this: DOMParser, source: unknown, type) {
    return measureParse(source, () => Reflect.apply(parse, this, [source, type]));
  };
  const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...innerHTML,
    set(value: unknown) {
      const set = () => innerHTML.set!.call(this, value);
      if (this instanceof HTMLTemplateElement) {
        measureParse(value, set);
      } else {
        set();
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
      burstSize: number;
    }) {
      if (window.WeakMap === ProbeWeakMap) {
        window.WeakMap = OriginalWeakMap;
      }
      Reflect.deleteProperty(ProbeWeakMap.prototype, "set");
      initialScrollHeight = document.querySelector("openclaw-chat-pane .chat-thread")!.scrollHeight;
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
          ((Math.floor(index / input.burstSize) + 1) * input.burstSize * 1000) /
            input.deltasPerSecond,
        );
      }
    },
    read() {
      return { active, delivered: deltas.length, finalReceived };
    },
    finish() {
      active = false;
      const thread = document.querySelector<HTMLElement>("openclaw-chat-pane .chat-thread")!;
      const tailPosition = {
        initialScrollHeight,
        scrollHeight: thread.scrollHeight,
        clientHeight: thread.clientHeight,
        scrollTop: thread.scrollTop,
        distanceFromBottom: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
      };
      if (!pipeline.streamWrites || !pipeline.publications || !pipeline.paneRenders) {
        throw new Error("Streaming owner probes did not capture the measured pipeline");
      }
      if (deltas.some((delta) => !Number.isFinite(delta.parseChars))) {
        throw new Error("Streaming HTML probe produced a non-finite character count");
      }
      const distribution = (values: number[]) => {
        const xs = values.toSorted((a, b) => a - b);
        const quantile = (q: number) => {
          const at = (xs.length - 1) * q;
          const lo = Math.floor(at);
          return xs.length ? xs[lo]! + (xs[Math.ceil(at)]! - xs[lo]!) * (at - lo) : 0;
        };
        return {
          median: quantile(0.5),
          p95: quantile(0.95),
          iqr: quantile(0.75) - quantile(0.25),
          min: xs[0] ?? 0,
          max: xs.at(-1) ?? 0,
        };
      };
      const optionalDistribution = (values: Array<number | undefined>) =>
        distribution(values.filter((value): value is number => value !== undefined));
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
          taskAndMicrotasksMs: optionalDistribution(
            samples.map((sample) => sample.taskAndMicrotasksMs),
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
        pipeline,
        tailPosition,
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
        inputToNextFrameMs: optionalDistribution(inputs.map((sample) => sample.nextFrameMs)),
        finalHtml: document.querySelector(".chat-bubble.streaming .chat-text")?.innerHTML ?? null,
      };
    },
  });
}
