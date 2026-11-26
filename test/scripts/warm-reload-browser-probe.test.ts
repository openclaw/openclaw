import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { installWarmReloadBrowserProbe } from "../../scripts/perf/warm-reload-browser-probe.ts";

let dom: JSDOM | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  dom?.window.close();
  dom = undefined;
});

function installProbe(cpuAttribution = false) {
  dom = new JSDOM("<!doctype html><body></body>", {
    url: "http://warm-reload.test/chat/synthetic",
    runScripts: "outside-only",
  });
  const window = dom.window;
  let browserError: unknown;
  window.addEventListener("error", (event) => {
    browserError = event.error ?? new Error(event.message);
    event.preventDefault();
  });
  const observers = new Map<string, ElementObserver>();
  class ElementObserver implements PerformanceObserver {
    static supportedEntryTypes = ["element", "long-animation-frame"];
    pending: PerformanceEntry[] = [];
    constructor(private readonly callback: PerformanceObserverCallback) {}
    observe(options: PerformanceObserverInit = {}) {
      if (options.type) {
        observers.set(options.type, this);
      }
    }
    disconnect() {}
    takeRecords(): PerformanceEntry[] {
      return this.pending.splice(0);
    }
    deliver(entries: PerformanceEntry[]) {
      this.callback(
        {
          getEntries: () => entries,
          getEntriesByName: (name) => entries.filter((entry) => entry.name === name),
          getEntriesByType: (type) => entries.filter((entry) => entry.entryType === type),
        },
        this,
      );
    }
  }
  Reflect.set(window, "PerformanceObserver", ElementObserver);
  Reflect.set(window, "__name", (fn: unknown) => fn);
  const markers: string[] = [];
  Reflect.set(window.console, "timeStamp", (label: string) => markers.push(label));
  const unexpectedGeometry = () => {
    throw new Error("Timing annotation must not read geometry");
  };
  vi.spyOn(window.Element.prototype, "getBoundingClientRect").mockImplementation(
    unexpectedGeometry,
  );
  vi.spyOn(window.Element.prototype, "getClientRects").mockImplementation(unexpectedGeometry);
  vi.spyOn(window, "getComputedStyle").mockImplementation(unexpectedGeometry);
  const traversedTexts: Node[] = [];
  const createTreeWalker = window.document.createTreeWalker.bind(window.document);
  vi.spyOn(window.document, "createTreeWalker").mockImplementation((...args) => {
    const walker = createTreeWalker(...args);
    const nextNode = walker.nextNode.bind(walker);
    vi.spyOn(walker, "nextNode").mockImplementation(() => {
      const node = nextNode();
      if (node?.nodeType === window.Node.TEXT_NODE) {
        traversedTexts.push(node);
      }
      return node;
    });
    return walker;
  });
  const probe = window.eval(
    `(${installWarmReloadBrowserProbe.toString()})("chat", false, false, false, ${cpuAttribution})`,
  );
  return {
    document: window.document,
    probe,
    traversedTexts,
    markers,
    loaf: (entry: PerformanceEntry, queued = false) => {
      const observer = observers.get("long-animation-frame")!;
      if (queued) {
        observer.pending.push(entry);
      } else {
        observer.deliver([entry]);
      }
    },
    flush: async () => {
      await new Promise<void>((resolve) => {
        window.queueMicrotask(resolve);
      });
      if (browserError) {
        throw new Error("Serialized warm-reload probe failed", { cause: browserError });
      }
    },
    paint: (element: Element, renderTime: number, visible = true) => {
      const identifier = element.getAttribute("elementtiming");
      if (!identifier) {
        return;
      }
      const entry = {
        name: "text-paint",
        entryType: "element",
        startTime: renderTime,
        duration: 0,
        renderTime,
        identifier,
        element,
        intersectionRect: new window.DOMRectReadOnly(0, 0, visible ? 40 : 0, 16),
        toJSON: () => ({ identifier, renderTime }),
      };
      observers.get("element")!.deliver([entry]);
    },
  };
}

it("preserves complete row and Details coverage while traversing overlapping mutation subtrees once", async () => {
  const { document, flush, traversedTexts } = installProbe();
  const wrapper = document.createElement("main");
  wrapper.innerHTML = `
    <header id="outside">Unrelated chrome</header>
    <div class="chat-virtual-row">
      <span id="existing" elementtiming="application-owned">Existing marker</span>
      <p id="row-text">First text <strong id="nested-text">Nested text</strong></p>
      <p id="row-tail">Later text</p>
    </div>
    <section class="chat-details-session">
      <p id="details-text">Details <em id="details-nested">Nested Details</em></p>
      <p id="details-tail">Later Details</p>
    </section>`;
  document.body.append(wrapper);
  const nested = wrapper.querySelector("#nested-text")!;
  nested.append(document.createTextNode(" appended text"));
  nested.firstChild!.textContent = "Updated nested text";
  const details = wrapper.querySelector("#details-nested")!;
  details.append(document.createTextNode(" appended Details"));
  details.firstChild!.textContent = "Updated nested Details";
  await flush();

  for (const id of ["row-text", "nested-text", "row-tail"]) {
    expect(wrapper.querySelector(`#${id}`)?.getAttribute("elementtiming"), id).toBe(
      "openclaw-transcript",
    );
  }
  for (const id of ["details-text", "details-nested", "details-tail"]) {
    expect(wrapper.querySelector(`#${id}`)?.getAttribute("elementtiming"), id).toBe(
      "openclaw-details",
    );
  }
  expect(wrapper.querySelector("#existing")?.getAttribute("elementtiming")).toBe(
    "application-owned",
  );
  expect(wrapper.querySelector("#outside")?.hasAttribute("elementtiming")).toBe(false);
  expect(traversedTexts.length).toBeGreaterThan(0);
  expect(new Set(traversedTexts).size).toBe(traversedTexts.length);
});

it("retains native LoAF attribution and drains pending entries without geometry reads", async () => {
  const { document, probe, flush, paint, loaf, markers } = installProbe(true);
  document.body.innerHTML = '<div class="chat-virtual-row"><p>Visible row</p></div>';
  await flush();
  const raw = {
    name: "long-animation-frame",
    entryType: "long-animation-frame",
    startTime: 20,
    duration: 80,
    blockingDuration: 30,
    renderStart: 80,
    styleAndLayoutStart: 82,
    scripts: [
      {
        invoker: "Promise.then",
        invokerType: "resolve-promise",
        startTime: 22,
        duration: 50,
        executionStart: 23,
        sourceURL: "http://warm-reload.test/assets/app.js",
        sourceFunctionName: "render",
        sourceCharPosition: 3,
        forcedStyleAndLayoutDuration: 12,
      },
    ],
  };
  loaf({ ...raw, toJSON: () => raw }, true);
  const row = document.querySelector("p")!;
  paint(row, 40);
  paint(row, 50);
  probe.finishCpuAttribution();
  expect(probe.cpuAttribution.loaf).toEqual([raw]);
  expect(probe.loafBlockingMs).toBe(30);
  expect(probe.cpuAttribution.droppedEntries).toBeNull();
  expect(probe.cpuAttribution.overflow).toBe(false);
  expect(markers).toEqual(["warm-reload-cpu:rows-observed"]);
  expect(probe.firstPaintedRowsMs).toBe(40);
});

it("annotates every giant-row leaf and later character data without changing first visible paint metrics", async () => {
  const { document, probe, flush, paint, markers } = installProbe();
  document.body.innerHTML = `
    <div class="chat-virtual-row">
      <span hidden>Hidden leading text</span>
      ${Array.from({ length: 64 }, (_, index) => `<p id="line-${index}">Paragraph ${index}</p>`).join("")}
      <span id="pending"></span>
    </div>
    <section class="chat-details-session"><p>Session Details</p></section>`;
  const pending = document.querySelector("#pending")!;
  const text = document.createTextNode("");
  pending.append(text);
  await flush();
  for (const paragraph of document.querySelectorAll(".chat-virtual-row p")) {
    expect(paragraph.getAttribute("elementtiming"), paragraph.id).toBe("openclaw-transcript");
  }
  expect(pending.hasAttribute("elementtiming")).toBe(false);
  const tail = document.querySelector("#line-63")!;
  paint(tail, 0);
  paint(tail, 80, false);
  expect(probe).toMatchObject({ firstPaintedRowsMs: null });
  paint(tail, 100);
  const details = document.querySelector(".chat-details-session p")!;
  paint(details, 120);
  expect(probe).toMatchObject({ firstPaintedRowsMs: 100, firstDetailsPaintMs: 120 });
  expect(probe.cpuAttribution).toBeUndefined();
  expect(markers).toEqual([]);

  text.data = "Text arriving after both first paints";
  const replacement = document.createElement("strong");
  replacement.textContent = "Replacement leaf";
  tail.replaceChildren(replacement);
  await flush();
  expect(pending.getAttribute("elementtiming")).toBe("openclaw-transcript");
  expect(replacement.getAttribute("elementtiming")).toBe("openclaw-transcript");
  paint(replacement, 200);
  expect(probe).toMatchObject({ firstPaintedRowsMs: 100, firstDetailsPaintMs: 120 });
});
