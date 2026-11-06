// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createEngineActionTiming } from "../../scripts/lib/control-ui-engine-action-timing.ts";
import { createControlUiMutationAudit } from "../../scripts/lib/control-ui-mutation-audit.ts";

let audit: ReturnType<typeof createControlUiMutationAudit> | undefined;
afterEach(() => {
  audit?.finish();
  audit = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
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
