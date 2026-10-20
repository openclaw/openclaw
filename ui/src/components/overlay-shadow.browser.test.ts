import { afterEach, expect, it, vi } from "vitest";
import { createOverlay, type Overlay, type OverlayOptions } from "./overlay-lifecycle.ts";

const owners: Overlay[] = [];
const hosts: HTMLElement[] = [];
let nextId = 0;

afterEach(() => {
  owners
    .splice(0)
    .toReversed()
    .forEach((owner) => owner.dispose());
  hosts.splice(0).forEach((host) => host.remove());
  vi.restoreAllMocks();
});

function shadow(mode: ShadowRootMode = "closed", parent: ParentNode = document.body) {
  const host = element("div", parent);
  return host.attachShadow({ mode });
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, root: ParentNode) {
  const node = document.createElement(tag);
  root.append(node);
  hosts.push(node);
  return node;
}

function fixture(root: ParentNode = shadow(), options: OverlayOptions = {}, parent?: Overlay) {
  const trigger = element("button", root);
  const surface = element("div", root);
  surface.popover = "manual";
  const action = element("button", surface);
  const owner = createOverlay(`shadow-${++nextId}`, parent, options);
  owner.bindSurface(surface);
  owner.bindTrigger(trigger);
  owners.push(owner);
  return { owner, surface, trigger, action };
}

async function open(owner: Overlay) {
  const done = new Promise<void>((resolve) => {
    owner.surface.addEventListener("overlay-after-show", () => resolve(), { once: true });
  });
  expect(owner.request(true)).toBe(true);
  await done;
}

function pointer(target: Element, type: "pointerdown" | "pointerup") {
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true, composed: true }));
}

function press(target: Element, release = target) {
  pointer(target, "pointerdown");
  pointer(release, "pointerup");
}

function frame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

it("keeps closed-shadow clicks and inside-to-outside gestures inside their starting branch", async () => {
  const current = fixture(shadow("closed", shadow()));
  const outside = element("button", document.body);
  let selectedWhileOpen = false;
  current.action.addEventListener("click", () => {
    selectedWhileOpen = current.owner.open;
  });
  await open(current.owner);

  press(current.action);
  current.action.click();
  await Promise.resolve();
  expect([selectedWhileOpen, current.owner.open]).toEqual([true, true]);

  press(current.action, outside);
  await Promise.resolve();
  expect(current.owner.open).toBe(true);

  const veto = (event: Event) => event.preventDefault();
  document.addEventListener("overlay-hide", veto, { once: true });
  press(outside);
  await Promise.resolve();
  expect([current.owner.open, current.surface.inert]).toEqual([true, false]);

  press(outside);
  await Promise.resolve();
  expect(current.owner.open).toBe(false);
});

it("gives closed-shadow controls the real Escape target once before dismissing the branch", async () => {
  let consumed = 0;
  const current = fixture(undefined, {
    onEscape(event) {
      if (event.target === search && search.value) {
        search.value = "";
        consumed += 1;
        return true;
      }
      return false;
    },
  });
  const search = element("input", current.surface);
  search.value = "Find";
  await open(current.owner);
  const escape = () =>
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
    );
  search.focus();
  escape();
  expect([search.value, consumed, current.owner.open]).toEqual(["", 1, true]);
  escape();
  expect([current.owner.open, consumed]).toEqual([false, 1]);
});

it.each(["inside", "outside"] as const)(
  "classifies a stopped pointer release from %s a closed root after capture finishes",
  async (position) => {
    const current = fixture();
    const outside = element("button", document.body);
    await open(current.owner);
    const target = position === "inside" ? current.action : outside;
    target.addEventListener("pointerup", (event) => event.stopPropagation(), { once: true });
    press(target);
    await frame();
    expect(current.owner.open).toBe(position === "inside");
  },
);

it.each(["pointerdown", "pointermove", "focusin"] as const)(
  "delivers %s policy facts once with the closed-root target before its handler",
  async (type) => {
    const received: [string, EventTarget | null][] = [];
    const current = fixture(shadow("closed", shadow()), {
      onInteraction(event, target) {
        if (event.type === type) {
          received.push(["policy", target]);
        }
      },
    });
    await open(current.owner);
    current.action.addEventListener(type, (event) => {
      received.push(["control", event.target]);
    });
    if (type === "focusin") {
      current.action.focus();
    } else {
      current.action.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true }));
    }
    expect(received).toEqual([
      ["policy", current.action],
      ["control", current.action],
    ]);
    expect(current.owner.open).toBe(true);
  },
);

it("allows the surface policy to dismiss an outside press before its target action", async () => {
  const root = shadow();
  const outside = element("button", root);
  const current: ReturnType<typeof fixture> = fixture(root, {
    onInteraction(event, target) {
      if (event.type === "pointerdown" && target === outside) {
        current.owner.request(false);
      }
    },
  });
  await open(current.owner);
  const stateAtAction: boolean[] = [];
  outside.addEventListener("pointerdown", () => stateAtAction.push(current.owner.open));
  pointer(outside, "pointerdown");
  expect(stateAtAction).toEqual([false]);
});

it.each(["surface", "trigger"] as const)(
  "retires descendants and releases leases when a %s is removed inside a closed root",
  async (removed) => {
    const release = vi.fn();
    const childRelease = vi.fn();
    const current = fixture(undefined, { acquireOcclusion: () => release });
    const child = fixture(current.surface, { acquireOcclusion: () => childRelease }, current.owner);
    await open(current.owner);
    await open(child.owner);
    current[removed].remove();
    await Promise.resolve();
    expect([current.owner.open, child.owner.open]).toEqual([false, false]);
    await frame();
    expect([release, childRelease].map((mock) => mock.mock.calls.length)).toEqual([1, 1]);
    expect(child.surface.matches(":popover-open")).toBe(false);
  },
);

it("reference-counts root listeners and disconnects observation after its last owner", async () => {
  const root = shadow();
  const added = vi.spyOn(root, "addEventListener");
  const removed = vi.spyOn(root, "removeEventListener");
  const observed = vi.spyOn(MutationObserver.prototype, "observe");
  const disconnected = vi.spyOn(MutationObserver.prototype, "disconnect");
  const first = fixture(root);
  const second = fixture(root);
  const registration = observed.mock.calls.findIndex(([target]) => target === root);
  expect(registration).toBeGreaterThanOrEqual(0);
  const observer = observed.mock.contexts[registration];
  const listeners = [...added.mock.calls];
  expect(listeners.map(([type]) => type).toSorted()).toEqual(
    "focusin focusin keydown pointercancel pointerdown pointerdown pointermove pointermove pointerup pointerup".split(
      " ",
    ),
  );
  first.owner.dispose();
  expect(removed).not.toHaveBeenCalled();
  expect(disconnected.mock.contexts).not.toContain(observer);
  second.owner.dispose();
  expect(removed.mock.calls).toEqual(listeners);
  expect(disconnected.mock.contexts).toContain(observer);
});

it("moves the surface-root effect once and ignores trigger-only root changes", async () => {
  const first = shadow();
  const second = shadow();
  const anchorRoot = shadow();
  const seen: string[] = [];
  const current = fixture(first, {
    onRootChange(root) {
      const name = root === first ? "first" : "second";
      seen.push(`attach:${name}`);
      return () => seen.push(`release:${name}`);
    },
  });
  await Promise.resolve();
  expect(seen).toEqual(["attach:first"]);
  second.append(current.surface);
  await Promise.resolve();
  expect(seen).toEqual(["attach:first", "release:first", "attach:second"]);
  const anchor = element("button", anchorRoot);
  current.owner.bindTrigger(anchor);
  current.owner.setReturnTarget(anchor);
  await Promise.resolve();
  expect(seen).toEqual(["attach:first", "release:first", "attach:second"]);
  current.owner.dispose();
  expect(seen).toEqual(["attach:first", "release:first", "attach:second", "release:second"]);
});

it("releases the surface-root effect on disconnect and reacquires it on remount", async () => {
  const root = shadow();
  const release = vi.fn();
  const attach = vi.fn(() => release);
  const current = fixture(root, { onRootChange: attach });
  expect(attach).toHaveBeenCalledExactlyOnceWith(root);
  root.host.remove();
  await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);
  document.body.append(root.host);
  await Promise.resolve();
  expect(attach).toHaveBeenCalledTimes(2);
  current.owner.dispose();
  expect(release).toHaveBeenCalledTimes(2);
});

it("tracks and replaces an SVG interaction anchor in a separate closed root", async () => {
  const surfaceRoot = shadow();
  const oldRoot = shadow();
  const newRoot = shadow();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  svg.append(path);
  oldRoot.append(svg);
  const replacement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  newRoot.append(replacement);
  let anchor: Element = svg;
  const received: (Node | null)[] = [];
  const added = vi.spyOn(oldRoot, "addEventListener");
  const removed = vi.spyOn(oldRoot, "removeEventListener");
  const rootChanged = vi.fn();
  const current = fixture(surfaceRoot, {
    interactionElements: () => [anchor],
    onInteraction: (event, target) => {
      if (event.type === "pointerdown") {
        received.push(target);
      }
    },
    onRootChange: rootChanged,
  });
  await open(current.owner);
  press(path);
  expect(received).toEqual([path]);
  expect([current.owner.contains(path), current.owner.open]).toEqual([true, true]);
  anchor = replacement;
  expect(current.owner.request(true)).toBe(true);
  expect(removed.mock.calls).toEqual(added.mock.calls);
  expect([current.owner.contains(svg), current.owner.contains(replacement)]).toEqual([false, true]);
  press(replacement);
  expect(received).toEqual([path, replacement]);
  expect(rootChanged).toHaveBeenCalledExactlyOnceWith(surfaceRoot);
});
