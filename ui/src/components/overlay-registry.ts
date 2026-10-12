import type { Overlay, OverlayOptions } from "./overlay-types.ts";

type OverlayRoot = Document | ShadowRoot;
type RegisteredOverlay = {
  options: OverlayOptions;
  valid(): boolean;
  elements(): Iterable<Element | undefined>;
  roots: Map<OverlayRoot, () => void>;
  surfaceRoot?: OverlayRoot;
  releaseSurfaceRoot?: () => void;
};
export type OverlayRegistry = {
  document: Document;
  members: Map<Overlay, RegisteredOverlay>;
  stack: Overlay[];
  nativeOrder: WeakMap<Overlay, number>;
  nextOrder: number;
  roots: Map<OverlayRoot, { references: number; release(): void }>;
  events?: ReturnType<typeof createRegistryEvents>;
};
const registries = new WeakMap<Document, OverlayRegistry>();

export function containsComposed(container: Element | undefined, target: Node | null): boolean {
  if (!container) {
    return false;
  }
  for (let current = target; current;) {
    if (container.contains(current)) {
      return true;
    }
    const view = current.ownerDocument?.defaultView;
    if (view && current instanceof view.Element && current.assignedSlot) {
      current = current.assignedSlot;
      continue;
    }
    const root = current.getRootNode();
    current = view && root instanceof view.ShadowRoot ? root.host : null;
  }
  return false;
}

export function registryFor(doc: Document): OverlayRegistry {
  let registry = registries.get(doc);
  if (!registry) {
    registry = {
      document: doc,
      members: new Map(),
      stack: [],
      nativeOrder: new WeakMap(),
      nextOrder: 0,
      roots: new Map(),
    };
    registries.set(doc, registry);
  }
  return registry;
}

/** Legacy callers can discover the same lifecycle tree from their actual anchor. */
export function findOverlayParent(anchor: Element): Overlay | undefined {
  let parent: Overlay | undefined;
  for (const overlay of registryFor(anchor.ownerDocument).members.keys()) {
    if (
      overlay.surface !== anchor &&
      containsComposed(overlay.surface, anchor) &&
      (!parent || containsComposed(parent.surface, overlay.surface))
    ) {
      parent = overlay;
    }
  }
  return parent;
}

export function orderStack(registry: OverlayRegistry) {
  registry.stack.sort(
    (a, b) => (registry.nativeOrder.get(a) ?? 0) - (registry.nativeOrder.get(b) ?? 0),
  );
}

export function reconcileNative(registry: OverlayRegistry, except?: Overlay) {
  for (const overlay of registry.members.keys()) {
    if (overlay !== except) {
      overlay.nativeToggle();
    }
  }
  orderStack(registry);
}

export function branchRevision(owner: Overlay): string {
  return JSON.stringify([owner.id, owner.revision, [...owner.children].map(branchRevision)]);
}

export function prepareClosures(
  registry: OverlayRegistry,
  readOwners: () => Overlay[],
  admitted: Set<Overlay>,
) {
  const prepared = new Map<Overlay, { commit: () => boolean; revision: string }>();
  for (;;) {
    reconcileNative(registry);
    const owners = readOwners();
    if (
      owners.some((owner) => !admitted.has(owner)) ||
      owners.some((owner) => {
        const prior = prepared.get(owner);
        return prior && prior.revision !== branchRevision(owner);
      })
    ) {
      return null;
    }
    const missing = owners.filter((owner) => !prepared.has(owner));
    if (missing.length === 0) {
      return {
        current() {
          reconcileNative(registry);
          const live = readOwners();
          return (
            live.length === owners.length &&
            live.every(
              (owner) =>
                owners.includes(owner) && prepared.get(owner)?.revision === branchRevision(owner),
            )
          );
        },
        commit() {
          for (const owner of owners) {
            if (!prepared.get(owner)?.commit()) {
              return false;
            }
          }
          return true;
        },
      };
    }
    for (const owner of missing) {
      const commit = owner.prepareClose();
      if (!commit) {
        return null;
      }
      prepared.set(owner, { commit, revision: branchRevision(owner) });
    }
  }
}

function collectRoots(elements: Iterable<Element | undefined>): Set<OverlayRoot> {
  const roots = new Set<OverlayRoot>();
  for (const element of elements) {
    if (!element) {
      continue;
    }
    const doc = element.ownerDocument;
    roots.add(doc);
    const view = doc.defaultView;
    let root = element.getRootNode();
    if (view) {
      while (root instanceof view.ShadowRoot) {
        roots.add(root);
        root = root.host.getRootNode();
      }
    }
  }
  return roots;
}

function connectedSurfaceRoot(surface: HTMLElement): OverlayRoot | undefined {
  if (!surface.isConnected) {
    return undefined;
  }
  const root = surface.getRootNode();
  const doc = surface.ownerDocument;
  if (root === doc) {
    return doc;
  }
  const view = doc.defaultView;
  return view && root instanceof view.ShadowRoot ? root : undefined;
}

function refreshSurfaceRoot(registry: OverlayRegistry, overlay: Overlay, entry: RegisteredOverlay) {
  const next = connectedSurfaceRoot(overlay.surface);
  if (next === entry.surfaceRoot) {
    return;
  }
  const release = entry.releaseSurfaceRoot;
  entry.releaseSurfaceRoot = undefined;
  entry.surfaceRoot = next;
  release?.();
  if (
    !next ||
    registry.members.get(overlay) !== entry ||
    connectedSurfaceRoot(overlay.surface) !== next
  ) {
    return;
  }
  const cleanup = entry.options.onRootChange?.(next);
  if (typeof cleanup === "function") {
    if (registry.members.get(overlay) === entry && connectedSurfaceRoot(overlay.surface) === next) {
      entry.releaseSurfaceRoot = cleanup;
    } else {
      cleanup();
    }
  }
}

export function refreshOverlayRoots(registry: OverlayRegistry, overlay: Overlay) {
  const registration = registry.members.get(overlay);
  if (!registration) {
    return;
  }
  const next = collectRoots(registration.elements());
  for (const root of next) {
    if (!registration.roots.has(root)) {
      registration.roots.set(root, retainRoot(registry, root));
    }
  }
  for (const [root, release] of registration.roots) {
    if (!next.has(root)) {
      release();
      registration.roots.delete(root);
    }
  }
  refreshSurfaceRoot(registry, overlay, registration);
}

export function registerOverlay(
  registry: OverlayRegistry,
  overlay: Overlay,
  registration: Omit<RegisteredOverlay, "roots">,
): () => void {
  const entry: RegisteredOverlay = { ...registration, roots: new Map() };
  registry.members.set(overlay, entry);
  return () => {
    if (registry.members.get(overlay) !== entry) {
      return;
    }
    registry.members.delete(overlay);
    const releaseSurface = entry.releaseSurfaceRoot;
    entry.releaseSurfaceRoot = undefined;
    entry.surfaceRoot = undefined;
    releaseSurface?.();
    registry.events?.forget(overlay);
    entry.roots.forEach((release) => release());
    entry.roots.clear();
  };
}

function createRegistryEvents(registry: OverlayRegistry) {
  type Press = { branch?: Overlay; revision: number; pointerId: number; canceled?: boolean };
  type Release = {
    started?: Press;
    target: Node | null;
    pointerId: number;
    frame?: number;
    finished: boolean;
  };
  type Interaction = {
    event: PointerEvent | FocusEvent;
    target: Node | null;
    recipients: { overlay: Overlay; revision: number }[];
    frame?: number;
    delivered: boolean;
  };
  let press: Press | undefined;
  const starts = new WeakMap<Event, Press>();
  const releases = new WeakMap<Event, Release>();
  const pending = new Set<Release>();
  const keys = new WeakSet<Event>();
  const focuses = new WeakSet<Event>();
  const interactions = new WeakMap<Event, Interaction>();
  const pendingInteractions = new Set<Interaction>();
  const finishInteraction = (interaction: Interaction) => {
    interaction.delivered = true;
    pendingInteractions.delete(interaction);
    if (interaction.frame !== undefined) {
      registry.document.defaultView?.cancelAnimationFrame(interaction.frame);
    }
  };
  const deliverInteraction = (interaction: Interaction) => {
    if (interaction.delivered) {
      return;
    }
    finishInteraction(interaction);
    for (const { overlay, revision } of interaction.recipients) {
      if (overlay.open && overlay.revision === revision) {
        registry.members
          .get(overlay)
          ?.options.onInteraction?.(interaction.event, interaction.target);
      }
    }
  };
  const waitsForDeeperRoot = (event: Event) => {
    const path = event.composedPath();
    const current = path.indexOf(event.currentTarget!);
    for (const root of registry.roots.keys()) {
      const view = root.ownerDocument?.defaultView;
      if (view && root instanceof view.ShadowRoot && root !== event.currentTarget) {
        const host = path.indexOf(root.host);
        if (host >= 0 && host < current) {
          return true;
        }
      }
    }
    return false;
  };
  const eventNode = (event: Event): Node | null => {
    const target = event.composedPath()[0];
    const view = registry.document.defaultView;
    return view && target instanceof view.Node ? target : null;
  };
  const captureInteraction = (event: PointerEvent | FocusEvent): Node | null => {
    const target = eventNode(event);
    if (!registry.stack.some((overlay) => registry.members.get(overlay)?.options.onInteraction)) {
      return target ?? null;
    }
    let interaction = interactions.get(event);
    if (!interaction) {
      interaction = {
        event,
        target: target ?? null,
        recipients: registry.stack.map((overlay) => ({ overlay, revision: overlay.revision })),
        delivered: false,
      };
      interactions.set(event, interaction);
      pendingInteractions.add(interaction);
      const current = interaction;
      interaction.frame = registry.document.defaultView?.requestAnimationFrame(() =>
        deliverInteraction(current),
      );
    }
    if (!interaction.delivered) {
      interaction.target = target ?? null;
      if (!waitsForDeeperRoot(event)) {
        deliverInteraction(interaction);
      }
    }
    return target ?? null;
  };
  const interactionBubble = (event: PointerEvent | FocusEvent) => {
    const interaction = interactions.get(event);
    if (interaction) {
      deliverInteraction(interaction);
    }
  };
  const outsidePointerBranch = (target: Node | null) =>
    registry.stack.find((entry) => {
      const options = registry.members.get(entry)?.options;
      return options?.dismissOutsidePointer !== false && !entry.contains(target);
    });
  const keydown = (event: KeyboardEvent) => {
    if (keys.has(event)) {
      return;
    }
    keys.add(event);
    if (event.key === "Escape") {
      reconcileNative(registry);
      registry.stack.at(-1)?.keydown(event);
    }
  };
  const pointerdown = (event: PointerEvent) => {
    let started = starts.get(event);
    if (!started) {
      reconcileNative(registry);
      started = { revision: 0, pointerId: event.pointerId };
      starts.set(event, started);
    }
    // Capture runs from document to the innermost registered root. Each root
    // refines the same gesture before closed-shadow retargeting hides its target.
    started.branch = outsidePointerBranch(captureInteraction(event));
    started.revision = started.branch?.revision ?? 0;
    press = started;
  };
  const finishRelease = (released: Release) => {
    if (released.finished) {
      return;
    }
    released.finished = true;
    pending.delete(released);
    if (released.frame !== undefined) {
      registry.document.defaultView?.cancelAnimationFrame(released.frame);
    }
    const started = released.started;
    if (press === started) {
      press = undefined;
    }
    if (!started || started.canceled || started.pointerId !== released.pointerId) {
      return;
    }
    const branch = started.branch;
    if (branch?.open && branch.revision === started.revision && !branch.contains(released.target)) {
      branch.request(false);
    }
  };
  const pointerupCapture = (event: PointerEvent) => {
    let release = releases.get(event);
    if (!release) {
      release = { started: press, target: null, pointerId: event.pointerId, finished: false };
      releases.set(event, release);
      const released = release;
      pending.add(release);
      // A stopped event never reaches root bubble listeners. Keep capture
      // dismissal, but wait until its closed-shadow targets have been sampled.
      release.frame = registry.document.defaultView?.requestAnimationFrame(() =>
        finishRelease(released),
      );
    }
    release.target = eventNode(event);
  };
  const pointerup = (event: PointerEvent) => {
    const released = releases.get(event);
    if (released) {
      finishRelease(released);
    }
  };
  const pointercancel = (event: PointerEvent) => {
    if (press?.pointerId === event.pointerId) {
      press.canceled = true;
      press = undefined;
    }
  };
  const focusin = (event: FocusEvent) => {
    interactionBubble(event);
    if (focuses.has(event)) {
      return;
    }
    focuses.add(event);
    if (press) {
      return;
    }
    reconcileNative(registry);
    const branch = registry.stack.find(
      (entry) =>
        registry.members.get(entry)?.options.dismissOutsideFocus !== false &&
        !entry.containsFocus(),
    );
    if (!branch) {
      return;
    }
    const revision = branch.revision;
    queueMicrotask(() => {
      if (!press && branch.open && branch.revision === revision && !branch.containsFocus()) {
        branch.request(false);
      }
    });
  };
  return {
    keydown,
    pointerdown,
    pointerdownBubble: interactionBubble,
    pointermove: captureInteraction,
    pointermoveBubble: interactionBubble,
    focusinCapture: captureInteraction,
    pointerupCapture,
    pointerup,
    pointercancel,
    focusin,
    forget(overlay: Overlay) {
      if (press?.branch === overlay) {
        press.canceled = true;
        press = undefined;
      }
    },
    dispose() {
      for (const interaction of pendingInteractions) {
        finishInteraction(interaction);
      }
      for (const release of pending) {
        if (release.started) {
          release.started.canceled = true;
        }
        finishRelease(release);
      }
      press = undefined;
    },
  };
}

function retainRoot(registry: OverlayRegistry, root: OverlayRoot): () => void {
  let binding = registry.roots.get(root);
  if (binding) {
    binding.references += 1;
  } else {
    const events = (registry.events ??= createRegistryEvents(registry));
    const listeners = [
      ["keydown", events.keydown, false],
      ["pointerdown", events.pointerdown, true],
      ["pointerdown", events.pointerdownBubble, false],
      ["pointermove", events.pointermove, true],
      ["pointermove", events.pointermoveBubble, false],
      ["pointerup", events.pointerupCapture, true],
      ["pointerup", events.pointerup, false],
      ["pointercancel", events.pointercancel, true],
      ["focusin", events.focusinCapture, true],
      ["focusin", events.focusin, false],
    ] as const;
    for (const [type, listener, capture] of listeners) {
      // SAFETY: Each table entry pairs its native event name with that event's handler.
      root.addEventListener(type, listener as EventListener, capture);
    }
    const observer = new MutationObserver(() => {
      const entries = Array.from(registry.members);
      for (const [entry, registration] of entries) {
        if (registry.members.get(entry) !== registration) {
          continue;
        }
        refreshOverlayRoots(registry, entry);
        if (!registration.valid()) {
          entry.retire();
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    binding = {
      references: 1,
      release() {
        observer.disconnect();
        for (const [type, listener, capture] of listeners) {
          // SAFETY: These are the same native event/handler pairs installed above.
          root.removeEventListener(type, listener as EventListener, capture);
        }
      },
    };
    registry.roots.set(root, binding);
  }
  const current = binding;
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    current.references -= 1;
    if (current.references === 0) {
      current.release();
      registry.roots.delete(root);
      if (registry.roots.size === 0) {
        registry.events?.dispose();
        registry.events = undefined;
      }
    }
  };
}

/** Optional document listener lifetime for callers that mount overlays later. */
export function installOverlayKeyboard(doc: Document): () => void {
  return retainRoot(registryFor(doc), doc);
}
