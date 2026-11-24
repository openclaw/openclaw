import type { ControlUiE2eFailureFact } from "./control-ui-e2e-diagnostics.ts";

// Playwright serializes this observer; keep runtime dependencies inside its body.
export function observeChatLayoutMenu(scope: Element) {
  if (!scope.matches(".chat-dashboard-menu")) {
    return null;
  }
  const document = scope.ownerDocument;
  const root = scope.closest("openclaw-chat-pane") ?? scope.parentElement ?? scope;
  const hostSelector = ".chat-dashboard-menu";
  const parts =
    '[data-part="trigger"], .oc-menu, [data-value="dashboard-expand"], [data-value="dashboard-swap"]';
  const identities = new WeakMap<Element, number>();
  const owners = new WeakMap<Element, Element>();
  let identity = 0;
  let sequence = 0;
  let dropped = 0;
  let beforeClick: ControlUiE2eFailureFact = null;
  const started = performance.now();
  const events: Record<string, ControlUiE2eFailureFact>[] = [];
  const safe = (value: string | null) =>
    value === null ||
    ["true", "false", "hidden", "opening", "open", "closing", "closed"].includes(value)
      ? value
      : "other";
  const nodeId = (node: Element) => {
    if (!identities.has(node)) {
      identities.set(node, ++identity);
    }
    return identities.get(node)!;
  };
  const describe = (node: Element | null) => {
    if (!node) {
      return null;
    }
    const part = node.closest(`${parts}, ${hostSelector}`);
    const host = node.closest(hostSelector) ?? (part ? owners.get(part) : null);
    if (host && part) {
      owners.set(part, host);
    }
    return {
      node: nodeId(part ?? node),
      element: nodeId(node),
      tag: [
        "html",
        "body",
        "div",
        "span",
        "button",
        "a",
        "svg",
        "path",
        "iframe",
        "dialog",
      ].includes(node.localName)
        ? node.localName
        : "other",
      host: host ? nodeId(host) : null,
      connected: node.isConnected,
      kind: !host
        ? "outside"
        : part === host
          ? "host"
          : part?.matches(".oc-menu")
            ? "surface"
            : part?.matches('[data-part="trigger"]')
              ? "trigger"
              : "item",
      action:
        ["dashboard-expand", "dashboard-swap"].find(
          (value) => value === part?.getAttribute("data-value"),
        ) ?? null,
      phase: safe(part?.getAttribute("data-phase") ?? null),
      state: safe(part?.getAttribute("data-state") ?? null),
      expanded: safe(part?.getAttribute("aria-expanded") ?? null),
    };
  };
  const record = (facts: Record<string, ControlUiE2eFailureFact>) => {
    const entry = { sequence: ++sequence, ms: Math.round(performance.now() - started), ...facts };
    events.push(entry);
    if (events.length > 200) {
      events.shift();
      dropped += 1;
    }
    return entry;
  };
  const mutations = (records: MutationRecord[]) => {
    for (const mutation of records) {
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (
          !(target instanceof Element) ||
          !target.matches(parts) ||
          !(target.closest(hostSelector) || owners.has(target))
        ) {
          continue;
        }
        record({
          type: "attribute",
          target: describe(target),
          attribute: mutation.attributeName,
          oldValue: safe(mutation.oldValue),
        });
      } else {
        for (const [type, nodes] of [
          ["removed", mutation.removedNodes],
          ["added", mutation.addedNodes],
        ] as const) {
          for (const node of nodes) {
            if (!(node instanceof Element)) {
              continue;
            }
            for (const part of [node, ...node.querySelectorAll(`${hostSelector}, ${parts}`)]) {
              if (
                part.matches(hostSelector) ||
                (part.matches(parts) && (part.closest(hostSelector) || owners.has(part)))
              ) {
                record({ type, target: describe(part) });
              }
            }
          }
        }
      }
    }
  };
  const observer = new MutationObserver(mutations);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-phase", "data-state", "aria-expanded"],
  });
  const types = [
    "pointerdown",
    "pointerup",
    "click",
    "focusin",
    "menu-select",
    "overlay-show",
    "overlay-hide",
    "overlay-after-show",
    "overlay-after-hide",
    "beforetoggle",
    "toggle",
  ];
  const onEvent = (event: Event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (
      !event.target.closest(hostSelector) &&
      !["pointerdown", "pointerup", "click", "focusin"].includes(event.type)
    ) {
      return;
    }
    mutations(observer.takeRecords());
    const entry: Record<string, ControlUiE2eFailureFact> = record({
      type: event.type,
      target: describe(event.target),
      active: describe(document.activeElement),
      prevented: event.defaultPrevented,
      eventPhase: event.eventPhase,
      trusted: event.isTrusted,
      pathLength: event.composedPath().length,
      path: event
        .composedPath()
        .slice(0, 16)
        .map((target) =>
          target instanceof Element
            ? describe(target)
            : {
                kind:
                  target === document
                    ? "document"
                    : target instanceof Window
                      ? "window"
                      : target instanceof ShadowRoot
                        ? "shadow-root"
                        : "other",
              },
        ),
      ...(event instanceof MouseEvent
        ? { x: event.clientX, y: event.clientY, button: event.button }
        : {}),
    });
    // Capture observes proposals before application listeners; read the final veto after dispatch.
    queueMicrotask(() => {
      entry.prevented = event.defaultPrevented;
    });
  };
  for (const type of types) {
    document.addEventListener(type, onEvent, true);
  }
  const snapshot = () => {
    const nodes = [];
    for (const host of root.querySelectorAll(hostSelector)) {
      nodes.push(describe(host));
      for (const part of host.querySelectorAll(parts)) {
        nodes.push(describe(part));
      }
    }
    return nodes;
  };
  record({ type: "start", nodes: snapshot() });
  return {
    captureBeforeClick(item: Element) {
      const box = item.getBoundingClientRect();
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const surface = item.closest(".oc-menu");
      const style = surface ? getComputedStyle(surface) : null;
      // Keep this outside the event ring so later input cannot evict the geometry.
      beforeClick = {
        ms: Math.round(performance.now() - started),
        item: describe(item),
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        center,
        hit: describe(document.elementFromPoint(center.x, center.y)),
        itemInert: item.closest("[inert]") !== null,
        itemPointerEvents: getComputedStyle(item).pointerEvents,
        surface:
          surface && style
            ? {
                ...describe(surface),
                transform: style.transform,
                scale: style.scale,
                translate: style.translate,
                pointerEvents: style.pointerEvents,
                inert: surface.hasAttribute("inert"),
              }
            : null,
      };
    },
    read() {
      mutations(observer.takeRecords());
      return { dropped, events, beforeClick, current: snapshot(), original: describe(scope) };
    },
    stop() {
      observer.disconnect();
      for (const type of types) {
        document.removeEventListener(type, onEvent, true);
      }
    },
  };
}
