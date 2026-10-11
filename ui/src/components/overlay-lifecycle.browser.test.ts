import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOverlay,
  findOverlayParent,
  type Overlay,
  type OverlayOptions,
  type OverlayPhase,
} from "./overlay-lifecycle.ts";

type Fixture = ReturnType<typeof mountOverlay>;
const owners: Overlay[] = [];
const roots: Element[] = [];
let nextId = 0;

afterEach(() => {
  for (const owner of owners.splice(0).toReversed()) {
    owner.dispose();
  }
  for (const root of roots.splice(0)) {
    root.remove();
  }
});

function mountOverlay(
  options: OverlayOptions = {},
  parent?: Overlay,
  doc = document,
  surfaceTag: "div" | "dialog" = "div",
) {
  const container = doc.createElement("section");
  const trigger = doc.createElement("button");
  trigger.textContent = "Open overlay";
  const surface = doc.createElement(surfaceTag);
  if (surfaceTag === "div") {
    surface.popover = "manual";
  }
  const item = doc.createElement("button");
  item.textContent = "Action";
  surface.append(item);
  container.append(trigger, surface);
  (parent?.surface ?? doc.body).append(container);
  roots.push(container);
  const owner = createOverlay(`overlay-${++nextId}`, parent, {
    exclusiveGroup: "menus",
    ...options,
  });
  owner.bindSurface(surface);
  owner.bindTrigger(trigger);
  owners.push(owner);
  return { owner, surface, trigger, item };
}

function completion(fixture: Fixture, phase: "open" | "hidden") {
  return new Promise<void>((resolve) => {
    fixture.surface.addEventListener(
      phase === "open" ? "overlay-after-show" : "overlay-after-hide",
      () => resolve(),
      { once: true },
    );
  });
}

async function open(fixture: Fixture) {
  const completed = completion(fixture, "open");
  expect(fixture.owner.request(true)).toBe(true);
  await completed;
}

function frame(doc = document) {
  return new Promise<void>((resolve) => {
    doc.defaultView!.requestAnimationFrame(() => resolve());
  });
}

function recordPhases(fixture: Fixture) {
  const phases: OverlayPhase[] = [];
  fixture.surface.addEventListener("overlay-after-show", () => phases.push(fixture.owner.phase));
  fixture.surface.addEventListener("overlay-after-hide", () => phases.push(fixture.owner.phase));
  return phases;
}

describe("native overlay lifecycle", () => {
  it("admits show and hide before changing accepted state, focus, or occlusion", async () => {
    const release = vi.fn();
    const acquireOcclusion = vi.fn(() => release);
    const initialFocus = vi.fn();
    const fixture = mountOverlay({ acquireOcclusion, onInitialFocus: initialFocus });
    fixture.trigger.focus();
    const vetoShow = (event: Event) => event.preventDefault();
    fixture.surface.addEventListener("overlay-show", vetoShow);

    expect(fixture.owner.request(true, "first")).toBe(false);
    expect(fixture.owner.open).toBe(false);
    expect(fixture.owner.phase).toBe("hidden");
    expect(fixture.surface.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(fixture.trigger);
    expect(initialFocus).not.toHaveBeenCalled();
    expect(acquireOcclusion).not.toHaveBeenCalled();

    fixture.surface.removeEventListener("overlay-show", vetoShow);
    await open(fixture);
    fixture.item.focus();
    const vetoHide = (event: Event) => {
      if (event.target === fixture.surface) {
        event.preventDefault();
      }
    };
    document.addEventListener("overlay-hide", vetoHide, { once: true });
    expect(fixture.owner.request(false, "return")).toBe(false);
    expect(fixture.owner.open).toBe(true);
    expect(fixture.owner.phase).toBe("open");
    expect(fixture.surface.inert).toBe(false);
    expect(document.activeElement).toBe(fixture.item);
    expect(release).not.toHaveBeenCalled();

    const hidden = completion(fixture, "hidden");
    expect(fixture.owner.request(false)).toBe(true);
    expect(fixture.owner.open).toBe(false);
    expect(fixture.owner.phase).toBe("closing");
    expect(fixture.surface.inert).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await hidden;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps ancestors and siblings unchanged when a descendant vetoes replacement", async () => {
    const root = mountOverlay();
    await open(root);
    const child = mountOverlay({}, root.owner);
    await open(child);
    const incoming = mountOverlay();
    child.surface.addEventListener("overlay-hide", (event) => event.preventDefault());

    expect(incoming.owner.request(true)).toBe(false);
    expect(root.owner.open).toBe(true);
    expect(child.owner.open).toBe(true);
    expect(incoming.owner.phase).toBe("hidden");
    expect(root.surface.inert).toBe(false);
    expect(child.surface.inert).toBe(false);
  });

  it("arbitrates a peer admitted by a hide listener before closing the existing branch", async () => {
    const outgoing = mountOverlay();
    const peer = mountOverlay();
    const incoming = mountOverlay();
    await open(outgoing);
    outgoing.surface.addEventListener("overlay-hide", () => peer.surface.showPopover(), {
      once: true,
    });
    peer.surface.addEventListener("overlay-hide", (event) => event.preventDefault());

    expect(incoming.owner.request(true)).toBe(false);
    expect(outgoing.owner.open).toBe(true);
    expect(peer.owner.open).toBe(true);
    expect(incoming.owner.open).toBe(false);
  });

  it("settles accepted descendant closes exactly once", async () => {
    const root = mountOverlay();
    await open(root);
    const child = mountOverlay({}, root.owner);
    await open(child);
    const rootPhases = recordPhases(root);
    const childPhases = recordPhases(child);
    const rootHidden = completion(root, "hidden");
    const childHidden = completion(child, "hidden");

    expect(root.owner.request(false)).toBe(true);
    await Promise.all([rootHidden, childHidden]);
    expect(rootPhases).toEqual(["hidden"]);
    expect(childPhases).toEqual(["hidden"]);
    expect(child.owner.open).toBe(false);
  });

  it.each([false, true])(
    "retires a child admitted by a native close callback, reopen=%s",
    async (reopen) => {
      const root = mountOverlay();
      const child = mountOverlay({}, root.owner);
      await open(root);
      const phases = recordPhases(root);
      const admission: { attempted: boolean; accepted: boolean; rejection?: string } = {
        attempted: false,
        accepted: false,
      };
      root.surface.addEventListener(
        "beforetoggle",
        (event) => {
          if ((event as ToggleEvent).newState === "closed") {
            admission.attempted = true;
            try {
              child.surface.showPopover();
              admission.accepted = child.surface.matches(":popover-open");
            } catch (error) {
              if (!(error instanceof DOMException) || error.name !== "InvalidStateError") {
                throw error;
              }
              admission.rejection = error.name;
            }
          }
        },
        { once: true },
      );
      const toggled = new Promise<void>((resolve) => {
        root.surface.addEventListener("toggle", () => resolve(), { once: true });
      });
      const hidden = reopen ? undefined : completion(root, "hidden");

      root.surface.hidePopover();
      if (reopen) {
        root.surface.showPopover();
      }
      await toggled;
      await hidden;
      expect(admission.attempted).toBe(true);
      expect(root.owner.open).toBe(reopen);
      expect(root.owner.phase).toBe(reopen ? "open" : "hidden");
      expect(root.surface.inert).toBe(!reopen);
      expect(child.owner.open, `native child admission: ${JSON.stringify(admission)}`).toBe(false);
      expect(child.surface.matches(":popover-open"), "no orphan native child").toBe(false);
      expect(phases).toEqual(reopen ? [] : ["hidden"]);
    },
  );

  it("does not let native callback removal of an incoming surface throw or reopen it", async () => {
    const outgoing = mountOverlay();
    await open(outgoing);
    const incoming = mountOverlay();
    const hidden = completion(outgoing, "hidden");
    outgoing.surface.addEventListener("beforetoggle", (event) => {
      if ((event as ToggleEvent).newState === "closed") {
        incoming.surface.remove();
      }
    });

    expect(incoming.owner.request(true)).toBe(false);
    await hidden;
    expect(incoming.owner.open).toBe(false);
    expect(outgoing.owner.open).toBe(false);
  });

  it("reopens after a native close callback supersedes the accepted close", async () => {
    const fixture = mountOverlay();
    await open(fixture);
    const phases = recordPhases(fixture);
    fixture.surface.addEventListener(
      "beforetoggle",
      (event) => {
        if ((event as ToggleEvent).newState === "closed") {
          fixture.owner.request(true);
        }
      },
      { once: true },
    );
    const shown = completion(fixture, "open");

    fixture.owner.request(false);
    await shown;
    expect(fixture.owner.open).toBe(true);
    expect(fixture.surface.matches(":popover-open")).toBe(true);
    expect(phases).toEqual(["open"]);
  });

  it("preserves the accepted hide when initial focus dismisses the opening", async () => {
    const fixture: Fixture = mountOverlay({ onInitialFocus: () => fixture.owner.request(false) });
    const phases = recordPhases(fixture);
    const hidden = completion(fixture, "hidden");

    expect(fixture.owner.request(true, "first")).toBe(false);
    await hidden;
    expect(fixture.owner.open).toBe(false);
    expect(phases).toEqual(["hidden"]);
  });

  it("does not restore focus for a close superseded by an accepted-state subscriber", async () => {
    const fixture = mountOverlay();
    await open(fixture);
    fixture.item.focus();
    fixture.owner.subscribe((opened) => {
      if (!opened) {
        fixture.owner.request(true);
      }
    });
    const shown = completion(fixture, "open");
    expect(fixture.owner.request(false, "return")).toBe(false);
    await shown;
    expect(fixture.owner.open).toBe(true);
    expect(document.activeElement).not.toBe(fixture.trigger);
  });

  it("keeps one show completion when initial focus repeats or vetoes a request", async () => {
    const fixture: Fixture = mountOverlay({
      onInitialFocus: () => {
        expect(fixture.owner.request(true)).toBe(true);
        expect(fixture.owner.request(false)).toBe(false);
      },
    });
    fixture.surface.addEventListener("overlay-hide", (event) => event.preventDefault());
    const phases = recordPhases(fixture);
    const shown = completion(fixture, "open");

    fixture.owner.request(true, "first");
    await shown;
    expect(fixture.owner.open).toBe(true);
    expect(phases).toEqual(["open"]);
  });

  it("notifies forced invalidation once before native hiding without accepting a veto", async () => {
    let enabled = true;
    const release = vi.fn();
    const fixture = mountOverlay({ isValid: () => enabled, acquireOcclusion: () => release });
    await open(fixture);
    enabled = false;
    const notifications: { cancelable: boolean; open: boolean; nativeOpen: boolean }[] = [];
    fixture.surface.addEventListener("overlay-hide", (event) => {
      notifications.push({
        cancelable: event.cancelable,
        open: fixture.owner.open,
        nativeOpen: fixture.surface.matches(":popover-open"),
      });
      event.preventDefault();
      expect(fixture.owner.request(false)).toBe(true);
      expect(fixture.owner.request(true)).toBe(false);
    });
    const phases = recordPhases(fixture);
    const hidden = completion(fixture, "hidden");
    fixture.owner.retire();
    await hidden;
    expect(notifications).toEqual([{ cancelable: false, open: true, nativeOpen: true }]);
    expect(phases).toEqual(["hidden"]);
    expect(fixture.owner.open).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not publish retirement completion when its notification renews valid open intent", async () => {
    const fixture = mountOverlay();
    await open(fixture);
    const phases = recordPhases(fixture);
    fixture.surface.addEventListener("overlay-hide", () => fixture.owner.request(true), {
      once: true,
    });
    fixture.owner.retire();
    await frame();
    expect(fixture.owner.open).toBe(true);
    expect(fixture.surface.matches(":popover-open")).toBe(true);
    expect(phases).toEqual([]);
  });

  it.each(["retire", "remove", "dispose"] as const)(
    "joins reentrant %s during forced hide without duplicate notifications or leaked leases",
    async (action) => {
      const release = vi.fn();
      const fixture = mountOverlay({ acquireOcclusion: () => release });
      await open(fixture);
      const phases = recordPhases(fixture);
      let hides = 0;
      fixture.surface.addEventListener("overlay-hide", () => {
        hides += 1;
        if (action === "remove") {
          fixture.surface.remove();
          fixture.owner.retire();
        } else if (action === "dispose") {
          fixture.owner.dispose();
        } else {
          fixture.owner.retire();
        }
      });
      fixture.owner.retire();
      await Promise.resolve();
      await frame();
      expect(hides).toBe(1);
      expect(fixture.owner.open).toBe(false);
      expect(fixture.surface.matches(":popover-open")).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
      expect(phases).toEqual(action === "retire" ? ["hidden"] : []);
    },
  );

  it.each(["opening", "open"] as const)(
    "silently retires a detached %s surface while releasing its lease",
    async (phase) => {
      const release = vi.fn();
      const fixture = mountOverlay({ acquireOcclusion: () => release });
      if (phase === "open") {
        await open(fixture);
      } else {
        expect(fixture.owner.request(true)).toBe(true);
      }
      const hides = vi.fn();
      fixture.surface.addEventListener("overlay-hide", hides);
      const phases = recordPhases(fixture);
      fixture.surface.remove();
      fixture.owner.retire();
      await frame();
      expect(hides).not.toHaveBeenCalled();
      expect(phases).toEqual([]);
      expect(fixture.owner.open).toBe(false);
      expect(fixture.owner.phase).toBe("hidden");
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores infinite animations and retains occlusion through finite closing work", async () => {
    const release = vi.fn();
    const fixture = mountOverlay({ acquireOcclusion: () => release });
    const spinner = fixture.surface.animate(
      { opacity: [0.8, 1] },
      { duration: 100, iterations: Infinity },
    );
    await open(fixture);
    expect(fixture.owner.phase).toBe("open");
    spinner.cancel();
    const fading = fixture.surface.animate({ opacity: [1, 0] }, { duration: 60_000 });
    const hidden = completion(fixture, "hidden");

    fixture.owner.request(false);
    await frame();
    expect(fixture.owner.phase).toBe("closing");
    expect(release).not.toHaveBeenCalled();
    fading.finish();
    await hidden;
    expect(fixture.owner.phase).toBe("hidden");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fences the closing completion after an animation reversal", async () => {
    const release = vi.fn();
    const fixture = mountOverlay({ acquireOcclusion: () => release });
    await open(fixture);
    const phases = recordPhases(fixture);
    const animation = fixture.surface.animate({ opacity: [1, 0] }, { duration: 60_000 });
    fixture.owner.request(false);
    await frame();
    const shown = completion(fixture, "open");

    expect(fixture.owner.request(true)).toBe(true);
    animation.cancel();
    await shown;
    expect(phases).toEqual(["open"]);
    expect(release).not.toHaveBeenCalled();
  });

  it.each(["div", "dialog"] as const)(
    "closes the old native %s surface before replacing an animated lifetime",
    async (surfaceTag) => {
      const release = vi.fn();
      const fixture = mountOverlay(
        {
          acquireOcclusion: () => release,
          native:
            surfaceTag === "dialog"
              ? {
                  isOpen: (element) => element.hasAttribute("open"),
                  show: (element) => {
                    if (element instanceof HTMLDialogElement) {
                      element.showModal();
                    }
                  },
                  hide: (element) => {
                    if (element instanceof HTMLDialogElement) {
                      element.close();
                    }
                  },
                }
              : undefined,
        },
        undefined,
        document,
        surfaceTag,
      );
      await open(fixture);
      const phases = recordPhases(fixture);
      const replacement = document.createElement(surfaceTag);
      if (surfaceTag === "div") {
        replacement.popover = "manual";
      }
      fixture.surface.parentElement!.append(replacement);
      const nativeSelector = surfaceTag === "dialog" ? ":modal" : ":popover-open";
      const animation = fixture.surface.animate({ opacity: [1, 0.9] }, { duration: 1000 });
      animation.pause();
      try {
        fixture.owner.bindSurface(replacement);
        expect(fixture.surface.matches(nativeSelector)).toBe(false);
        expect(fixture.surface.inert).toBe(true);
        expect(fixture.owner.surface).toBe(replacement);
        expect(fixture.owner.open).toBe(false);
        expect(release).toHaveBeenCalledTimes(1);

        await open({ ...fixture, surface: replacement });
        animation.finish();
        await frame();
        expect(replacement.matches(nativeSelector)).toBe(true);
        expect(fixture.owner.open).toBe(true);
        expect(phases).toEqual([]);
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        animation.cancel();
      }
    },
  );

  it("waits for a paused finite animation before publishing completion", async () => {
    const fixture = mountOverlay();
    const animation = fixture.surface.animate({ opacity: [0, 1] }, { duration: 60_000 });
    animation.pause();
    const shown = completion(fixture, "open");
    expect(fixture.owner.request(true)).toBe(true);
    await frame();
    expect(fixture.owner.phase).toBe("opening");
    animation.finish();
    await shown;
    expect(fixture.owner.phase).toBe("open");
  });

  it("retires detached content without retaining a stale completion on remount", async () => {
    const release = vi.fn();
    const fixture = mountOverlay({ acquireOcclusion: () => release });
    await open(fixture);
    const phases = recordPhases(fixture);
    const parent = fixture.surface.parentNode!;
    fixture.surface.remove();
    await Promise.resolve();
    expect(fixture.owner.open).toBe(false);
    expect(fixture.owner.phase).toBe("hidden");
    expect(release).toHaveBeenCalledTimes(1);

    parent.appendChild(fixture.surface);
    await open(fixture);
    expect(phases).toEqual(["open"]);
  });

  it("keeps generic empty surfaces and independently grouped overlays open", async () => {
    const first = mountOverlay({ exclusiveGroup: undefined });
    const second = mountOverlay({ exclusiveGroup: "independent" });
    await open(first);
    await open(second);
    first.item.remove();
    await Promise.resolve();
    expect(first.owner.open).toBe(true);
    expect(second.owner.open).toBe(true);
  });

  it.each([
    { outer: "open", inner: "open" },
    { outer: "open", inner: "closed" },
    { outer: "closed", inner: "open" },
    { outer: "closed", inner: "closed" },
  ] as const)(
    "retains focus inside $outer shadow overlays and $inner nested inputs",
    async ({ outer, inner }) => {
      const fixture = mountOverlay();
      const host = document.createElement("div");
      document.body.append(host);
      roots.push(host);
      const root = host.attachShadow({ mode: outer });
      root.append(fixture.surface.parentElement!);
      const inputHost = document.createElement("span");
      fixture.surface.append(inputHost);
      const inputRoot = inputHost.attachShadow({ mode: inner });
      const input = document.createElement("input");
      inputRoot.append(input);
      const outside = document.createElement("button");
      document.body.append(outside);
      roots.push(outside);
      await open(fixture);

      fixture.item.focus();
      await Promise.resolve();
      expect(fixture.owner.open).toBe(true);
      expect(root.activeElement).toBe(fixture.item);
      input.focus();
      await Promise.resolve();
      expect(fixture.owner.open).toBe(true);
      expect(inputRoot.activeElement).toBe(input);
      expect(fixture.owner.contains(input)).toBe(true);
      expect(fixture.owner.containsFocus()).toBe(true);

      outside.focus();
      input.focus();
      await Promise.resolve();
      expect(fixture.owner.open).toBe(true);
      const hidden = completion(fixture, "hidden");
      outside.focus();
      await hidden;
      expect(fixture.owner.open).toBe(false);
      expect(document.activeElement).toBe(outside);
    },
  );

  it.each(["trigger", "return target"] as const)(
    "recognizes focus on a portaled overlay's %s inside a separate closed root",
    async (target) => {
      const fixture = mountOverlay();
      const host = document.createElement("div");
      document.body.append(host);
      roots.push(host);
      const root = host.attachShadow({ mode: "closed" });
      const owned = target === "trigger" ? fixture.trigger : document.createElement("button");
      root.append(owned);
      if (target === "return target") {
        fixture.owner.setReturnTarget(owned);
      }
      await open(fixture);
      owned.focus();
      await Promise.resolve();
      expect(root.activeElement).toBe(owned);
      expect(fixture.owner.containsFocus()).toBe(true);
      expect(fixture.owner.open).toBe(true);
    },
  );

  it.each(["implicit", "explicit"] as const)(
    "rebinds an open trigger while preserving the %s return-focus target",
    async (returnFocus) => {
      const fixture = mountOverlay();
      const replacement = document.createElement("button");
      replacement.textContent = "Replacement trigger";
      const explicit = document.createElement("button");
      explicit.textContent = "Durable return target";
      fixture.trigger.parentElement!.append(replacement, explicit);
      if (returnFocus === "explicit") {
        fixture.owner.setReturnTarget(explicit);
      }
      await open(fixture);
      expect(fixture.trigger.getAttribute("aria-expanded")).toBe("true");
      fixture.owner.bindTrigger(replacement);
      expect(fixture.trigger.getAttribute("aria-expanded")).toBe("false");
      expect(replacement.getAttribute("aria-expanded")).toBe("true");
      fixture.item.focus();
      const hidden = completion(fixture, "hidden");
      fixture.item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await hidden;
      expect(document.activeElement).toBe(returnFocus === "explicit" ? explicit : replacement);
      expect(replacement.getAttribute("aria-expanded")).toBe("false");
    },
  );

  it("isolates peer arbitration to the surface document", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    roots.push(iframe);
    const first = mountOverlay();
    const second = mountOverlay({}, undefined, iframe.contentDocument!);
    await open(first);
    await open(second);
    expect(first.owner.open).toBe(true);
    expect(second.owner.open).toBe(true);
    const hidden = completion(second, "hidden");
    second.surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await hidden;
    expect(first.owner.open).toBe(true);
  });

  it("discovers nearest physical ancestry and retires before changing parent ownership", async () => {
    const first = mountOverlay({ exclusiveGroup: undefined });
    const second = mountOverlay({ exclusiveGroup: undefined });
    const nested = mountOverlay({}, first.owner);
    expect(findOverlayParent(nested.item)).toBe(nested.owner);
    expect(findOverlayParent(nested.trigger)).toBe(first.owner);
    await open(first);
    await open(second);
    await open(nested);
    const hidden = completion(nested, "hidden");
    nested.owner.setParent(second.owner);
    await hidden;
    expect(nested.owner.open).toBe(false);
    expect(nested.owner.parent).toBe(second.owner);
    expect(first.owner.children.has(nested.owner)).toBe(false);
    expect(second.owner.children.has(nested.owner)).toBe(true);
    expect(() => second.owner.setParent(nested.owner)).toThrow("its own ancestor");
    await open(nested);
    first.owner.dispose();
    expect(nested.owner.open).toBe(true);
  });

  it("rejects a cross-document parent without changing the current lifetime", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    roots.push(iframe);
    const first = mountOverlay({ exclusiveGroup: undefined });
    const foreign = mountOverlay({}, undefined, iframe.contentDocument!);
    await open(first);
    expect(() => first.owner.setParent(foreign.owner)).toThrow("another document");
    expect(first.owner.open).toBe(true);
    expect(first.owner.parent).toBeUndefined();
  });

  it("requires both pointer endpoints outside and preserves the new outside focus", async () => {
    const fixture = mountOverlay();
    const outside = document.createElement("button");
    document.body.append(outside);
    roots.push(outside);
    await open(fixture);
    fixture.item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 4 }));
    outside.focus();
    outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 4 }));
    await Promise.resolve();
    expect(fixture.owner.open).toBe(true);

    const hidden = completion(fixture, "hidden");
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 5 }));
    outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 5 }));
    await hidden;
    expect(document.activeElement).toBe(outside);
  });

  it("uses native dialog operations without menu peer arbitration or content assumptions", async () => {
    const fixture = mountOverlay(
      {
        exclusiveGroup: undefined,
        dismissOutsideFocus: false,
        dismissOutsidePointer: false,
        native: {
          isOpen: (element) => element.hasAttribute("open"),
          show: (element) => {
            if (element instanceof HTMLDialogElement) {
              element.showModal();
            }
          },
          hide: (element) => {
            if (element instanceof HTMLDialogElement) {
              element.close();
            }
          },
        },
      },
      undefined,
      document,
      "dialog",
    );
    await open(fixture);
    const menu = mountOverlay({}, fixture.owner);
    await open(menu);
    const hidden = completion(menu, "hidden");
    menu.item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await hidden;
    expect(fixture.owner.open).toBe(true);
    expect(fixture.surface.hasAttribute("open")).toBe(true);
    fixture.surface.addEventListener("overlay-hide", (event) => event.preventDefault(), {
      once: true,
    });
    expect(fixture.owner.request(false)).toBe(false);
    expect(fixture.surface.hasAttribute("open")).toBe(true);
  });

  it("lets embedded controls consume Escape before dismissing the deepest branch", async () => {
    const root = mountOverlay();
    await open(root);
    let hasQuery = true;
    const child = mountOverlay(
      {
        onEscape: () => {
          const consumed = hasQuery;
          hasQuery = false;
          return consumed;
        },
      },
      root.owner,
    );
    await open(child);
    const escape = () =>
      child.item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    escape();
    expect(hasQuery).toBe(false);
    expect(child.owner.open).toBe(true);
    const hidden = completion(child, "hidden");
    escape();
    await hidden;
    expect(root.owner.open).toBe(true);
  });
});
