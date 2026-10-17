import { render as renderSolid } from "@solidjs/web";
import { createComponent } from "solid-js";
import { vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { createChatPaneView } from "./chat-pane-runtime-view.tsx";
import { ChatPaneStateOwner } from "./chat-pane-state-owner.ts";
import type { ChatPaneProps } from "./chat-pane.tsx";

export type PaneRuntimeConstructor<R extends ChatPaneRuntime> = new (
  element: HTMLElement,
  context: ApplicationContext,
) => R;

export type PaneTestLifecycle = {
  requestUpdate(): void;
  prepareRender(): void;
  commitRender(): void;
  connectedCallback(): void;
  disconnectedCallback(): void;
};

const paneTestRuntimes = new WeakMap<HTMLElement, ChatPaneRuntime>();

/** Keep the real owner behind legacy test access; browser DOM operations use .element. */
export function createPaneTestHost<R extends ChatPaneRuntime>(
  tag: string,
  Runtime: PaneRuntimeConstructor<R>,
  createContext: () => ApplicationContext,
): R & HTMLElement & PaneTestLifecycle {
  if (!customElements.get(tag)) {
    customElements.define(
      tag,
      class extends HTMLElement {
        private readonly runtime = new Runtime(this, createContext());
        private dispose: (() => void) | undefined;
        constructor() {
          super();
          paneTestRuntimes.set(this, this.runtime);
        }
        connectedCallback() {
          if (this.dispose) {
            return;
          }
          this.runtime.isConnected = false;
          const runtime = this.runtime;
          // The fixture forwards protected runtime fields; match the production bridge's context.
          const context = Reflect.get(runtime, "context") as ApplicationContext;
          this.dispose = renderSolid(
            () =>
              createComponent(ApplicationProvider, {
                value: context,
                get children() {
                  return createChatPaneView(runtime);
                },
              }),
            this,
          );
        }
        disconnectedCallback() {
          if (this.dispose) {
            this.dispose();
            this.dispose = undefined;
          } else {
            this.runtime.dispose();
          }
        }
      },
    );
  }
  const element = document.createElement(tag);
  const runtime = paneTestRuntimes.get(element)!;
  const bound = new WeakMap<object, unknown>();
  const lifecycle = new Set(["connectedCallback", "disconnectedCallback"]);
  // Direct fixture assignments stand in for the bridge's explicit invalidation.
  const inputs = new Set<string>([
    "mcpAppLaunch",
    "paneId",
    "paneLabel",
    "presentationId",
    "chatMessagesBySession",
    "sessionSnapshotStore",
    "sessionKey",
    "routeLoadingSkeleton",
    "agentId",
    "inputRegion",
    "compact",
    "onBackToSubagents",
    "workContext",
    "draft",
    "focusComposer",
    "dashboardExpanded",
    "routeFace",
    "onFaceChange",
    "onFocusPane",
    "onSessionDeleted",
    "narrow",
    "mergedChrome",
    "navDrawerOpen",
    "onboarding",
    "onOpenSplitView",
    "onSplitDown",
    "onSplitRight",
    "onClosePane",
    "boardProvider",
  ] satisfies (keyof ChatPaneProps)[]);
  const runtimeKey = (key: string | symbol) => (key === "requestUpdate" ? "invalidate" : key);
  const owner = (key: PropertyKey) =>
    !lifecycle.has(String(key)) && (key in runtime || !(key in element)) ? runtime : element;
  const pane = new Proxy(element, {
    get(_target, key) {
      if (key === "willUpdate") {
        return (changes: Map<PropertyKey, unknown>) =>
          runtime.synchronizeInputs({
            sessionKey: changes.has("sessionKey"),
            inputRegion: changes.has("inputRegion"),
            draft: changes.has("draft"),
          });
      }
      if (key === "updated") {
        return (changes?: Map<PropertyKey, unknown>) =>
          runtime.afterRender(changes?.has("focusComposer") ?? false);
      }
      if (key === "prepareRender") {
        return () => {
          runtime.chatState.prepareRender();
          runtime.synchronizeInputs({});
        };
      }
      if (key === "commitRender") {
        return () => {
          runtime.afterRender(false);
          runtime.chatState.commitRender();
        };
      }
      const mappedKey = runtimeKey(key);
      const source = owner(mappedKey);
      const value: unknown = Reflect.get(source, mappedKey);
      if (typeof value !== "function" || vi.isMockFunction(value)) {
        return value;
      }
      if (!bound.has(value)) {
        bound.set(value, value.bind(source));
      }
      return bound.get(value);
    },
    set(_target, key, value) {
      const mappedKey = runtimeKey(key);
      const source = owner(mappedKey);
      const previous = Reflect.get(source, mappedKey);
      const applied = Reflect.set(source, mappedKey, value);
      if (applied && inputs.has(String(mappedKey)) && !Object.is(previous, value)) {
        runtime.invalidate();
      }
      return applied;
    },
    defineProperty(_target, key, descriptor) {
      const mappedKey = runtimeKey(key);
      return Reflect.defineProperty(owner(mappedKey), mappedKey, descriptor);
    },
    deleteProperty(_target, key) {
      const mappedKey = runtimeKey(key);
      return Reflect.deleteProperty(owner(mappedKey), mappedKey);
    },
    getOwnPropertyDescriptor(_target, key) {
      const mappedKey = runtimeKey(key);
      const source = owner(mappedKey);
      for (let current: object | null = source; current; current = Object.getPrototypeOf(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, mappedKey);
        if (descriptor) {
          return { ...descriptor, configurable: true };
        }
      }
      return undefined;
    },
    has(_target, key) {
      const mappedKey = runtimeKey(key);
      return mappedKey in runtime || mappedKey in element;
    },
  });
  // SAFETY: This test adapter forwards controller members and native DOM access to their owners.
  return pane as R & HTMLElement & PaneTestLifecycle;
}

export function getPaneTestRuntime(pane: { element: HTMLElement }): ChatPaneRuntime {
  return paneTestRuntimes.get(pane.element)!;
}

/** Render-cadence tests use the real view with only its base connection lifecycle. */
export function connectPaneTestView(pane: { element: HTMLElement }) {
  const runtime = getPaneTestRuntime(pane);
  runtime.start = () => ChatPaneStateOwner.prototype.start.call(runtime);
  runtime.dispose = () => ChatPaneStateOwner.prototype.dispose.call(runtime);
  const connect: unknown = Reflect.get(pane.element, "connectedCallback");
  if (typeof connect === "function") {
    connect.call(pane.element);
  }
}
