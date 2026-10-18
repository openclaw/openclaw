import { afterEach, describe, expect, it, vi } from "vitest";
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
  const host = document.createElement("div");
  parent.append(host);
  hosts.push(host);
  return host.attachShadow({ mode });
}

function fixture(root: ParentNode, options: OverlayOptions = {}, parent?: Overlay) {
  const trigger = document.createElement("button");
  trigger.textContent = "Open";
  const surface = document.createElement("div");
  surface.popover = "manual";
  const action = document.createElement("button");
  action.textContent = "Action";
  surface.append(action);
  root.append(trigger, surface);
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

function frame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("overlay shadow-root ownership", () => {
  it("keeps closed-shadow clicks and inside-to-outside gestures inside their starting branch", async () => {
    const root = shadow("closed", shadow());
    const current = fixture(root);
    const outside = document.createElement("button");
    document.body.append(outside);
    hosts.push(outside);
    let selectedWhileOpen = false;
    current.action.addEventListener("click", () => {
      selectedWhileOpen = current.owner.open;
    });
    await open(current.owner);

    pointer(current.action, "pointerdown");
    pointer(current.action, "pointerup");
    current.action.click();
    await Promise.resolve();
    expect(selectedWhileOpen).toBe(true);
    expect(current.owner.open).toBe(true);

    pointer(current.action, "pointerdown");
    pointer(outside, "pointerup");
    await Promise.resolve();
    expect(current.owner.open).toBe(true);

    const veto = (event: Event) => event.preventDefault();
    document.addEventListener("overlay-hide", veto, { once: true });
    pointer(outside, "pointerdown");
    pointer(outside, "pointerup");
    await Promise.resolve();
    expect(current.owner.open).toBe(true);
    expect(current.surface.inert).toBe(false);

    pointer(outside, "pointerdown");
    pointer(outside, "pointerup");
    await Promise.resolve();
    expect(current.owner.open).toBe(false);
  });

  it("gives closed-shadow controls the real Escape target once before dismissing the branch", async () => {
    let consumed = 0;
    const root = shadow();
    const current = fixture(root, {
      onEscape(event) {
        if (event.target === search && search.value) {
          search.value = "";
          consumed += 1;
          return true;
        }
        return false;
      },
    });
    const search = document.createElement("input");
    search.value = "Find";
    current.surface.append(search);
    await open(current.owner);
    const escape = () =>
      search.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          composed: true,
        }),
      );
    search.focus();
    escape();
    expect(search.value).toBe("");
    expect(consumed).toBe(1);
    expect(current.owner.open).toBe(true);
    escape();
    expect(current.owner.open).toBe(false);
    expect(consumed).toBe(1);
  });

  it.each(["inside", "outside"] as const)(
    "classifies a stopped pointer release from %s a closed root after capture finishes",
    async (position) => {
      const root = shadow();
      const current = fixture(root);
      const outside = document.createElement("button");
      document.body.append(outside);
      hosts.push(outside);
      await open(current.owner);
      const target = position === "inside" ? current.action : outside;
      target.addEventListener("pointerup", (event) => event.stopPropagation(), { once: true });
      pointer(target, "pointerdown");
      pointer(target, "pointerup");
      await frame();
      expect(current.owner.open).toBe(position === "inside");
    },
  );

  it.each(["pointerdown", "pointermove", "focusin"] as const)(
    "delivers %s policy facts once with the closed-root target before its handler",
    async (type) => {
      const root = shadow("closed", shadow());
      const received: { source: string; target: EventTarget | null }[] = [];
      const current = fixture(root, {
        onInteraction(event, target) {
          if (event.type === type) {
            received.push({ source: "policy", target });
          }
        },
      });
      await open(current.owner);
      current.action.addEventListener(type, (event) => {
        received.push({ source: "control", target: event.target });
      });
      if (type === "focusin") {
        current.action.focus();
      } else {
        current.action.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true }));
      }
      expect(received).toEqual([
        { source: "policy", target: current.action },
        { source: "control", target: current.action },
      ]);
      expect(current.owner.open).toBe(true);
    },
  );

  it("allows the surface policy to dismiss an outside press before its target action", async () => {
    const root = shadow();
    const outside = document.createElement("button");
    const current: ReturnType<typeof fixture> = fixture(root, {
      onInteraction(event, target) {
        if (event.type === "pointerdown" && target === outside) {
          current.owner.request(false);
        }
      },
    });
    root.append(outside);
    await open(current.owner);
    const stateAtAction: boolean[] = [];
    outside.addEventListener("pointerdown", () => stateAtAction.push(current.owner.open));
    pointer(outside, "pointerdown");
    expect(stateAtAction).toEqual([false]);
  });

  it.each(["surface", "trigger"] as const)(
    "retires descendants and releases leases when a %s is removed inside a closed root",
    async (removed) => {
      const root = shadow();
      const release = vi.fn();
      const childRelease = vi.fn();
      const current = fixture(root, { acquireOcclusion: () => release });
      const child = fixture(
        current.surface,
        { acquireOcclusion: () => childRelease },
        current.owner,
      );
      await open(current.owner);
      await open(child.owner);
      current[removed].remove();
      await Promise.resolve();
      expect(current.owner.open).toBe(false);
      expect(child.owner.open).toBe(false);
      await frame();
      expect(release).toHaveBeenCalledTimes(1);
      expect(childRelease).toHaveBeenCalledTimes(1);
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
    expect(listeners.map(([type]) => type).toSorted()).toEqual([
      "focusin",
      "focusin",
      "keydown",
      "pointercancel",
      "pointerdown",
      "pointerdown",
      "pointermove",
      "pointermove",
      "pointerup",
      "pointerup",
    ]);
    first.owner.dispose();
    expect(removed).not.toHaveBeenCalled();
    expect(disconnected.mock.contexts).not.toContain(observer);
    second.owner.dispose();
    expect(removed.mock.calls).toEqual(listeners);
    expect(disconnected.mock.contexts).toContain(observer);
  });

  it.each(["trigger", "return target"] as const)(
    "releases the previous %s root when the anchor is replaced",
    (kind) => {
      const oldRoot = shadow();
      const newRoot = shadow();
      const current = fixture(document.body);
      hosts.push(current.surface, current.trigger);
      const oldAnchor = document.createElement("button");
      const newAnchor = document.createElement("button");
      oldRoot.append(oldAnchor);
      newRoot.append(newAnchor);
      const added = vi.spyOn(oldRoot, "addEventListener");
      const removed = vi.spyOn(oldRoot, "removeEventListener");
      if (kind === "trigger") {
        current.owner.bindTrigger(oldAnchor);
        current.owner.bindTrigger(newAnchor);
      } else {
        current.owner.setReturnTarget(oldAnchor);
        current.owner.setReturnTarget(newAnchor);
      }
      expect(added.mock.calls).toHaveLength(10);
      expect(removed.mock.calls).toEqual(added.mock.calls);
      current.owner.dispose();
    },
  );

  it("moves the surface-root effect once and ignores trigger-only root changes", async () => {
    const first = shadow();
    const second = shadow();
    const anchorRoot = shadow();
    const seen: string[] = [];
    const current = fixture(first, {
      onRootChange(root) {
        const name = root === first ? "first" : "second";
        seen.push(`attach:${name}`);
        const style = document.createElement("style");
        (root instanceof ShadowRoot ? root : root.head).append(style);
        return () => {
          seen.push(`release:${name}`);
          style.remove();
        };
      },
    });
    await Promise.resolve();
    expect(seen).toEqual(["attach:first"]);
    second.append(current.surface);
    await Promise.resolve();
    expect(seen).toEqual(["attach:first", "release:first", "attach:second"]);
    const anchor = document.createElement("button");
    anchorRoot.append(anchor);
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
    pointer(path, "pointerdown");
    pointer(path, "pointerup");
    expect(received).toEqual([path]);
    expect(current.owner.contains(path)).toBe(true);
    expect(current.owner.open).toBe(true);
    anchor = replacement;
    expect(current.owner.request(true)).toBe(true);
    expect(removed.mock.calls).toEqual(added.mock.calls);
    expect(current.owner.contains(svg)).toBe(false);
    expect(current.owner.contains(replacement)).toBe(true);
    pointer(replacement, "pointerdown");
    pointer(replacement, "pointerup");
    expect(received).toEqual([path, replacement]);
    expect(rootChanged).toHaveBeenCalledExactlyOnceWith(surfaceRoot);
  });
});
