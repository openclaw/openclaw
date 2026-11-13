// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createEngineActionTiming } from "../../scripts/lib/control-ui-engine-action-timing.ts";
import { createControlUiLiveRegionAudit } from "../../scripts/lib/control-ui-live-region-audit.ts";
import { createControlUiMutationAudit } from "../../scripts/lib/control-ui-mutation-audit.ts";

let audit: ReturnType<typeof createControlUiMutationAudit> | undefined;
afterEach(() => {
  audit?.finish();
  audit = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("records off-log updates separately from a nested polite atomic status", async () => {
  const log = document.createElement("div");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "off");
  const stream = document.createElement("p");
  stream.textContent = "First delta";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  log.append(stream, status);
  document.body.append(log);
  const live = createControlUiLiveRegionAudit();
  live.start();
  stream.firstChild!.nodeValue = "Next delta";
  await Promise.resolve();
  status.textContent = "Final answer. ".repeat(50);
  await Promise.resolve();
  const result = live.finish();
  expect(result.samples.find((sample) => sample.role === "log")).toMatchObject({
    effective: { live: "off" },
    textSample: "Next delta",
  });
  const announcement = result.samples.find((sample) => sample.role === "status");
  expect(announcement).toMatchObject({
    raw: { live: "polite", atomic: "true" },
    effective: { live: "polite", atomic: "true" },
    ancestorLiveOff: true,
    textLength: status.textContent.length,
    textSample: status.textContent.slice(0, 500),
  });
  expect(announcement!.textSample.length).toBeLessThanOrEqual(500);
});

it("distinguishes equal writes from changes that return to their starting value", () => {
  const node = document.createElement("span");
  node.setAttribute("title", "a");
  node.textContent = "a";
  document.body.append(node);
  audit = createControlUiMutationAudit();
  audit.start();
  node.setAttribute("title", "a");
  node.setAttribute("title", "b");
  node.setAttribute("title", "a");
  node.firstChild!.nodeValue = "a";
  node.firstChild!.nodeValue = "b";
  node.firstChild!.nodeValue = "a";
  expect(audit.finish()).toMatchObject({
    attributes: 3,
    unchangedAttributes: 1,
    text: 3,
    unchangedText: 1,
    valueNoopRatio: 1 / 3,
  });
});

it("observes existing and newly attached open roots and separates moves from replacements", () => {
  const existing = document.createElement("div");
  const oldRoot = existing.attachShadow({ mode: "open" });
  const oldText = document.createTextNode("unchanged");
  oldRoot.append(oldText);
  const added = document.createElement("div");
  const list = document.createElement("ul");
  const moved = document.createElement("li");
  moved.textContent = "retained";
  const replaced = document.createElement("li");
  replaced.textContent = "recreated";
  const anchor = document.createComment("");
  list.append(moved, replaced);
  list.append(anchor);
  document.body.append(existing, added, list);
  audit = createControlUiMutationAudit();
  audit.start();
  oldText.nodeValue = "unchanged";
  const newRoot = added.attachShadow({ mode: "open" });
  newRoot.append(document.createElement("span"));
  list.append(moved);
  replaced.replaceWith(replaced.cloneNode(true));
  anchor.replaceWith(document.createComment(""));
  expect(audit.finish()).toMatchObject({
    observedRoots: 3,
    unchangedText: 1,
    removedNodes: 3,
    addedNodes: 4,
    movedIdentical: 1,
    recreatedIdentical: 1,
  });
});

it("counts cached bound formatter calls only during the action and restores descriptors", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format");
  audit = createControlUiMutationAudit();
  const date = new Intl.DateTimeFormat("en-US");
  // oxlint-disable-next-line typescript/unbound-method -- Intl.format is a getter returning a bound function.
  const format = date.format;
  // oxlint-disable-next-line typescript/unbound-method -- Repeated getter access must preserve that bound function identity.
  expect(date.format).toBe(format);
  const expected = format(0);
  audit.start();
  expect(format(0)).toBe(expected);
  expect(new Intl.RelativeTimeFormat("en").format(-1, "day")).toBe("1 day ago");
  expect(audit.finish().formatters).toEqual({
    "Intl.DateTimeFormat.format": 1,
    "Intl.RelativeTimeFormat.format": 1,
  });
  expect(Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format")).toEqual(
    descriptor,
  );
});

it("measures a Gateway response from browser-local delivery through its last DOM commit", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(10);
  const node = document.createElement("div");
  document.body.append(node);
  const timing = createEngineActionTiming(false);
  timing.start();
  try {
    clock.mockReturnValue(20);
    node.setAttribute("title", "before response");
    await Promise.resolve();
    clock.mockReturnValue(30);
    window.openclawEngineMarkGatewayInput!();
    clock.mockReturnValue(40);
    node.setAttribute("title", "response applied");
    await Promise.resolve();
    clock.mockReturnValue(50);
    timing.endScenario();
    clock.mockReturnValue(60);
    expect(timing.finish()).toMatchObject({
      inputSource: "gateway",
      inputCount: 1,
      mutationCount: 1,
      firstCommitMs: 40,
      firstCommitLatencyMs: 10,
      activations: [],
      driverMs: 20,
      applicationMs: 10,
      assertionTailMs: 10,
      settleMs: 20,
    });
    expect(window.openclawEngineMarkGatewayInput).toBeUndefined();
  } finally {
    timing.endScenario();
  }
});

it("separates two native activations without counting pointerup or click as inputs", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(10);
  const listeners = vi.spyOn(document, "addEventListener");
  const node = document.createElement("div");
  document.body.append(node);
  const timing = createEngineActionTiming(false);
  timing.start();
  const native = (type: string, at: number) => {
    clock.mockReturnValue(at);
    const listener = listeners.mock.calls.find(([name]) => name === type)?.[1];
    if (typeof listener !== "function") {
      throw new Error(`Missing native input listener: ${type}`);
    }
    // Scripted DOM events cannot be trusted; supply the browser's event boundary.
    listener.call(
      document,
      new Proxy(new Event(type), {
        get: (event, key) => (key === "isTrusted" ? true : Reflect.get(event, key, event)),
      }),
    );
  };
  try {
    native("pointerdown", 20);
    clock.mockReturnValue(25);
    node.setAttribute("title", "pointerdown focus");
    await Promise.resolve();
    native("pointerup", 30);
    native("click", 35);
    clock.mockReturnValue(40);
    node.setAttribute("title", "first click applied");
    await Promise.resolve();
    native("pointerdown", 50);
    native("pointerup", 55);
    native("click", 60);
    clock.mockReturnValue(65);
    node.setAttribute("title", "second click applied");
    await Promise.resolve();
    clock.mockReturnValue(70);
    timing.endScenario();
    expect(timing.finish()).toMatchObject({
      firstInputMs: 20,
      lastInputMs: 50,
      firstCommitMs: 25,
      lastCommitMs: 65,
      firstCommitLatencyMs: 5,
      applicationMs: 45,
      inputCount: 2,
      mutationCount: 3,
      activationsTruncated: false,
      activations: [
        {
          type: "pointerdown",
          pointerdownMs: 20,
          pointerupMs: 30,
          clickMs: 35,
          firstCommitMs: 25,
          lastCommitMs: 40,
          firstMutationMs: 25,
          firstMutationAfterClickMs: 40,
          lastMutationMs: 40,
          firstCommitLatencyMs: 5,
          clickToFirstMutationMs: 5,
          mutationCount: 2,
        },
        {
          type: "pointerdown",
          pointerdownMs: 50,
          pointerupMs: 55,
          clickMs: 60,
          firstCommitMs: 65,
          lastCommitMs: 65,
          firstMutationMs: 65,
          firstMutationAfterClickMs: 65,
          lastMutationMs: 65,
          firstCommitLatencyMs: 15,
          clickToFirstMutationMs: 5,
          mutationCount: 1,
        },
      ],
    });
  } finally {
    timing.endScenario();
  }
});

it("bounds native activation detail while preserving the full action's counters", () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const listeners = vi.spyOn(document, "addEventListener");
  const timing = createEngineActionTiming(false);
  timing.start();
  try {
    const listener = listeners.mock.calls.find(([name]) => name === "input")?.[1];
    if (typeof listener !== "function") {
      throw new Error("Missing native input listener");
    }
    for (let index = 1; index <= 101; index++) {
      clock.mockReturnValue(index);
      listener.call(
        document,
        new Proxy(new Event("input"), {
          get: (event, key) => (key === "isTrusted" ? true : Reflect.get(event, key, event)),
        }),
      );
    }
    timing.endScenario();
    const result = timing.finish();
    expect(result).toMatchObject({
      inputCount: 101,
      firstCommitMs: 1,
      lastCommitMs: 101,
      firstCommitLatencyMs: 0,
      applicationMs: 100,
      activationsTruncated: true,
    });
    expect(result.activations).toHaveLength(100);
    expect(result.activations[99]).toMatchObject({
      firstCommitMs: 100,
      lastCommitMs: 100,
      commitSource: "native-value",
    });
  } finally {
    timing.endScenario();
  }
});
