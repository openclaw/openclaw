import type { Locator, Page } from "playwright";
import { vi } from "vitest";
import type { ChatPaneElement } from "../pages/chat/chat-pane.tsx";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";

// The suite installs this private runtime probe on every browser context.
type DiagnosticChatPane = ChatPaneElement & { readonly state?: ChatPageHost };

export async function observeManagedMediaCapture(
  page: Page,
  bubble: Locator,
  intro: string,
  phase: "live" | "reloaded",
) {
  const liveNodes = await bubble.evaluateHandle((element) => {
    const pane = element.closest<DiagnosticChatPane>("openclaw-chat-pane");
    const readPresentation = (target: ChatPaneElement | null) => ({
      presented: target?.presented ?? null,
      visuallyPresented: target?.visuallyPresented ?? null,
      conversationPresented: target?.conversationPresented ?? null,
    });
    const policyValues = new Map<unknown, number>();
    const policyIdentity = (value: unknown) => {
      if (value === undefined || value === null) {
        return null;
      }
      if (!policyValues.has(value)) {
        policyValues.set(value, policyValues.size + 1);
      }
      return policyValues.get(value)!;
    };
    // Compare policy inputs without exporting workspace paths or session identities.
    const readPolicy = (target: DiagnosticChatPane | null) => {
      const state = target?.state;
      const row = state?.sessionsResult?.sessions.find(
        (candidate) => candidate.key === state.sessionKey,
      );
      return {
        epoch: state?.mediaPolicyEpoch ?? 0,
        selectedRow: Boolean(row),
        sessionId: policyIdentity(row?.sessionId),
        permissionMode: policyIdentity(row?.permissionMode),
        permissionModePending: policyIdentity(row?.permissionModePending),
        execNode: policyIdentity(row?.execNode),
        execCwd: policyIdentity(row?.execCwd),
        sessionRoot: policyIdentity(row?.sessionRoot),
        spawnedWorkspaceDir: policyIdentity(row?.spawnedWorkspaceDir),
        spawnedCwd: policyIdentity(row?.spawnedCwd),
        worktree: policyIdentity(row?.worktree?.id),
      };
    };
    const events = {
      presentation: 0,
      lifecycle: 0,
      conversationPresentedFalse: 0,
      shellRootLifecycleAggregate: 0,
    };
    const abort = new AbortController();
    const observe = (kind: "presentation" | "lifecycle") => {
      events[kind] += 1;
      if (pane?.conversationPresented === false) {
        events.conversationPresentedFalse += 1;
      }
    };
    pane?.addEventListener("openclaw:presentation-changed", () => observe("presentation"), {
      signal: abort.signal,
    });
    pane?.addEventListener("openclaw-chat-pane-lifecycle-changed", () => observe("lifecycle"), {
      signal: abort.signal,
    });
    const shellRoot = pane?.closest("openclaw-app-shell");
    shellRoot?.addEventListener(
      "openclaw-chat-pane-lifecycle-changed",
      () => {
        events.shellRootLifecycleAggregate += 1;
      },
      { signal: abort.signal },
    );
    const identities = new WeakMap<Node, number>();
    const sources = new Map<string, number>();
    const records: Array<Record<string, unknown>> = [];
    const knownNodes = new WeakSet<Node>([element, ...element.querySelectorAll("*")]);
    const startedAt = performance.now();
    let nextIdentity = 1;
    let dropped = 0;
    const identity = (node: Node | null) => {
      if (!node) {
        return null;
      }
      let id = identities.get(node);
      if (id === undefined) {
        identities.set(node, (id = nextIdentity++));
      }
      return id;
    };
    // Opaque per-capture identities compare URLs without exporting signed URLs or payloads.
    const sourceIdentity = (value: string) => {
      if (!value) {
        return null;
      }
      if (!sources.has(value) && sources.size < 256) {
        sources.set(value, sources.size + 1);
      }
      return sources.get(value) ?? -1;
    };
    const snapshot = (node: Node) => {
      const image = node instanceof HTMLImageElement ? node : null;
      return {
        id: identity(node),
        connected: node.isConnected,
        parent: identity(node.parentNode),
        parentConnected: node.parentNode?.isConnected ?? null,
        kind:
          node === element
            ? "bubble"
            : node instanceof Element
              ? node.matches("img.chat-message-image")
                ? "image"
                : node.matches(".chat-image-frame")
                  ? "frame"
                  : node.matches(".chat-message-images")
                    ? "gallery"
                    : "ancestor"
              : "node",
        ...(image
          ? {
              source: sourceIdentity(image.getAttribute("src") ?? ""),
              currentSource: sourceIdentity(image.currentSrc),
              decoded: image.complete && image.naturalWidth > 0,
            }
          : {}),
      };
    };
    const record = (kind: string, nodes: Node[] = [], stack?: string[]) => {
      if (records.length === 128) {
        records.shift();
        dropped++;
      }
      records.push({
        at: Math.round((performance.now() - startedAt) * 1000) / 1000,
        kind,
        nodes: nodes.slice(0, 8).map(snapshot),
        omittedNodes: Math.max(0, nodes.length - 8),
        stack,
        bubbleConnected: element.isConnected,
        rowConnected: element.closest("[data-chat-row-key]")?.isConnected ?? false,
        presentation: readPresentation(pane),
        policy: readPolicy(pane),
      });
    };
    const relevant = (node: Node) =>
      node === element || element.contains(node) || node.contains(element);
    const noteRemoval = (kind: string, node: Node, parent: Node | null) => {
      if (!relevant(node)) {
        return;
      }
      const stack = (new Error().stack ?? "")
        .split("\n")
        .flatMap((line) => {
          const location = line.match(/\/assets\/[a-zA-Z0-9_.-]+\.js:\d+:\d+/u)?.[0];
          return location ? [location] : [];
        })
        .slice(0, 6);
      record(kind, parent ? [node, parent] : [node], stack);
    };
    // Call through unchanged; only the synthetic bubble's removals export sanitized stacks.
    const removeDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "remove")!;
    const nativeRemove = Function.prototype.call.bind(removeDescriptor.value);
    const observedRemove = function (this: Element) {
      noteRemoval("remove", this, this.parentNode);
      nativeRemove(this);
    };
    const removeChildDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "removeChild")!;
    const nativeRemoveChild = Function.prototype.call.bind(removeChildDescriptor.value);
    const observedRemoveChild = function <T extends Node>(this: Node, child: T): T {
      noteRemoval("removeChild", child, this);
      // The native operation returns the exact supplied child; preserve its generic contract.
      nativeRemoveChild(this, child);
      return child;
    };
    Element.prototype.remove = observedRemove;
    Node.prototype.removeChild = observedRemoveChild;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (relevant(mutation.target)) {
            record("attribute:" + mutation.attributeName, [mutation.target]);
          }
        } else {
          const removed = Array.from(mutation.removedNodes).filter(
            (node) => relevant(node) || knownNodes.has(node),
          );
          const added = Array.from(mutation.addedNodes).filter((node) => relevant(node));
          for (const node of added) {
            knownNodes.add(node);
            if (node instanceof Element) {
              for (const child of node.querySelectorAll("*")) {
                knownNodes.add(child);
              }
            }
          }
          if (removed.length) {
            record("removed", removed);
          }
          if (added.length) {
            record("added", added);
          }
        }
      }
    });
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "class", "hidden", "aria-hidden", "aria-busy", "style"],
    });
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, {
        childList: true,
        attributes: true,
        attributeFilter: ["hidden", "aria-hidden", "class", "style"],
      });
    }
    const noteImageEvent = (event: Event) => {
      if (event.target instanceof HTMLImageElement) {
        record(event.type, [event.target]);
      }
    };
    element.addEventListener("load", noteImageEvent, { capture: true, signal: abort.signal });
    element.addEventListener("error", noteImageEvent, { capture: true, signal: abort.signal });
    record("installed", [
      element,
      ...element.querySelectorAll(".chat-image-frame,img.chat-message-image"),
    ]);
    const galleries = Array.from(element.querySelectorAll(".chat-message-images"));
    return {
      bubble: element,
      row: element.closest("[data-chat-row-key]"),
      text: element.querySelector(".chat-text"),
      galleries,
      galleryParents: galleries.map((gallery) => gallery.parentElement),
      frames: Array.from(element.querySelectorAll(".chat-image-frame")),
      images: Array.from(element.querySelectorAll("img.chat-message-image")),
      pane,
      presentation: readPresentation(pane),
      policy: readPolicy(pane),
      readPresentation,
      readPolicy,
      events,
      mark: (stage: string) => record(stage),
      trace: () => ({ records: [...records], dropped }),
      stop: () => {
        observer.disconnect();
        abort.abort();
        if (Element.prototype.remove === observedRemove) {
          Object.defineProperty(Element.prototype, "remove", removeDescriptor);
        }
        if (Node.prototype.removeChild === observedRemoveChild) {
          Object.defineProperty(Node.prototype, "removeChild", removeChildDescriptor);
        }
        sources.clear();
        return {
          removeRestored: Element.prototype.remove === removeDescriptor.value,
          removeChildRestored: Node.prototype.removeChild === removeChildDescriptor.value,
          listenersAborted: abort.signal.aborted,
        };
      },
    };
  });

  let captured = false;
  let reported = false;
  const mark = (stage: string) => liveNodes.evaluate((state, value) => state.mark(value), stage);
  const context = page.context();
  const newSession = context.newCDPSession.bind(context);
  const restores: Array<() => void> = [];
  const sessionSpy = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
    const session = await newSession(target);
    if (target !== page) {
      return session;
    }
    const send = session.send.bind(session);
    const sendSpy = vi.spyOn(session, "send").mockImplementation(async (method, params) => {
      const isCapture = method === "Page.captureScreenshot";
      if (isCapture) {
        await mark("before-cdp-capture");
      }
      try {
        return await send(method, params);
      } finally {
        if (isCapture) {
          captured = true;
          await mark("after-cdp-capture");
        }
      }
    });
    restores.push(() => sendSpy.mockRestore());
    return session;
  });
  restores.push(() => sessionSpy.mockRestore());
  return {
    observeTargets(targets: readonly Locator[]) {
      const spies = [...new Set(targets)].map((target, index) => {
        const resolve = target.elementHandles.bind(target);
        return vi.spyOn(target, "elementHandles").mockImplementation(async () => {
          if (captured) {
            await mark("post-capture-target-" + index + "-resolve-start");
          }
          const handles = await resolve();
          if (captured) {
            await mark("post-capture-target-" + index + "-resolve-end");
          }
          return handles;
        });
      });
      return () => {
        for (const spy of spies) {
          spy.mockRestore();
        }
      };
    },
    finishCapture: () => mark("capture-helper-finished").catch(() => undefined),
    async report() {
      const diagnostic = await liveNodes.evaluate((before, expectedIntro) => {
        const matches = Array.from(
          document.querySelectorAll(".chat-group.assistant .chat-bubble"),
        ).filter((element) => element.textContent?.includes(expectedIntro));
        const current = matches.length === 1 ? matches[0] : undefined;
        const pane = current?.closest<DiagnosticChatPane>("openclaw-chat-pane") ?? null;
        const galleries = Array.from(current?.querySelectorAll(".chat-message-images") ?? []);
        const frames = Array.from(current?.querySelectorAll(".chat-image-frame") ?? []);
        const count = (selector: string) => current?.querySelectorAll(selector).length ?? 0;
        const slots = Array.from(current?.querySelectorAll(".chat-text div") ?? []).filter(
          (element) =>
            Array.from(element.childNodes).some(
              (node) => node.nodeType === Node.COMMENT_NODE && node.textContent === "lit-content",
            ),
        );
        return {
          schemaVersion: 1,
          kind: "managed-image-order-after-capture",
          trace: before.trace(),
          policy: { before: before.policy, after: before.readPolicy(pane) },
          matchingBubbles: matches.length,
          originalBubbleConnected: before.bubble.isConnected,
          sameBubble: current === before.bubble,
          originalRowConnected: before.row?.isConnected ?? null,
          sameRow: before.row ? current?.closest("[data-chat-row-key]") === before.row : null,
          originalTextConnected: before.text?.isConnected ?? null,
          sameText: before.text ? current?.querySelector(".chat-text") === before.text : null,
          originalGalleries: before.galleries.map((gallery, index) => ({
            connected: gallery.isConnected,
            sameGallery: galleries[index] === gallery,
            originalParentConnected: before.galleryParents[index]?.isConnected ?? null,
            sameParent: galleries[index]?.parentElement === before.galleryParents[index],
          })),
          originalFrames: before.frames.map((frame, index) => ({
            connected: frame.isConnected,
            sameFrame: frames[index] === frame,
          })),
          samePane: pane === before.pane,
          presentation: {
            before: before.presentation,
            after: before.readPresentation(pane),
            events: before.events,
          },
          originalImages: before.images.map((image) => ({
            connected: image.isConnected,
            inOriginalBubble: before.bubble.contains(image),
            inCurrentBubble: current?.contains(image) ?? false,
          })),
          current: {
            images: count("img.chat-message-image"),
            allImages: count("img"),
            galleries: count(".chat-message-images"),
            frames: count(".chat-image-frame"),
            skeletons: count(".chat-image-skeleton"),
            unavailable: count(".chat-image-frame--compact"),
            busyFrames: count('.chat-image-frame[aria-busy="true"]'),
            mediaSlots: slots.map((slot) => ({
              childElements: slot.childElementCount,
              images: slot.querySelectorAll("img.chat-message-image").length,
              galleries: slot.querySelectorAll(".chat-message-images").length,
            })),
          },
        };
      }, intro);
      reported = true;
      console.error(
        "[control-ui-e2e] managed image order failure",
        JSON.stringify({ ...diagnostic, phase }),
      );
    },
    async stop() {
      for (const restore of restores.toReversed()) {
        restore();
      }
      try {
        if (!reported && !page.isClosed()) {
          const trace = await liveNodes.evaluate((state) => state.trace()).catch(() => undefined);
          console.info(
            "[control-ui-e2e] managed image capture trace",
            JSON.stringify({ phase, ...trace }),
          );
        }
      } finally {
        try {
          const cleanup = await liveNodes
            .evaluate((before) => before.stop())
            .catch(() => undefined);
          console.info(
            "[control-ui-e2e] managed image diagnostic cleanup",
            JSON.stringify(cleanup),
          );
        } finally {
          await liveNodes.dispose();
        }
      }
    },
  };
}
