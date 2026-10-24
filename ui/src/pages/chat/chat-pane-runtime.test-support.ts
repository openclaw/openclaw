import { render as renderSolid } from "@solidjs/web";
import { createComponent } from "solid-js";
import { vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { chatPanePropertyKeys } from "./chat-pane-inputs.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { createChatPaneView } from "./chat-pane-runtime-view.tsx";
import { ChatPaneStateOwner } from "./chat-pane-state-owner.ts";

export type PaneRuntimeConstructor<R extends ChatPaneRuntime> = new (
  element: HTMLElement,
  context: ApplicationContext,
) => R;

export type PaneTestLifecycle = {
  awaitDomCommit(): Promise<boolean>;
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
  const inputs = new Set<string>(chatPanePropertyKeys);
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
          runtime.chatState.publishPendingRunState();
          runtime.chatState.captureRenderChanges();
          runtime.synchronizeInputs({});
        };
      }
      if (key === "commitRender") {
        return () => {
          runtime.afterRender(false);
          runtime.chatState.commitRender();
        };
      }
      const source = owner(key);
      const value: unknown = Reflect.get(source, key);
      if (typeof value !== "function" || vi.isMockFunction(value)) {
        return value;
      }
      if (!bound.has(value)) {
        bound.set(value, value.bind(source));
      }
      return bound.get(value);
    },
    set(_target, key, value) {
      const source = owner(key);
      const previous = Reflect.get(source, key);
      if (inputs.has(String(key)) && !Object.is(previous, value)) {
        runtime.chatState.publishPendingRunState();
      }
      const applied = Reflect.set(source, key, value);
      if (applied && inputs.has(String(key)) && !Object.is(previous, value)) {
        if (runtime.isConnected) {
          void runtime.awaitDomCommit();
          runtime.synchronizeInputs({
            sessionKey: key === "sessionKey",
            inputRegion: key === "inputRegion",
            draft: key === "draft",
            focusComposer: key === "focusComposer",
          });
          runtime.refreshBoardSubscriptions();
        }
      }
      return applied;
    },
    defineProperty(_target, key, descriptor) {
      return Reflect.defineProperty(owner(key), key, descriptor);
    },
    deleteProperty(_target, key) {
      return Reflect.deleteProperty(owner(key), key);
    },
    getOwnPropertyDescriptor(_target, key) {
      const source = owner(key);
      for (let current: object | null = source; current; current = Object.getPrototypeOf(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) {
          return { ...descriptor, configurable: true };
        }
      }
      return undefined;
    },
    has(_target, key) {
      return key in runtime || key in element;
    },
  });
  // SAFETY: This test adapter forwards runtime members and native DOM access to their owners.
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
