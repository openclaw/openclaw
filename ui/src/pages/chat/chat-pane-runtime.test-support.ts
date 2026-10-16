import { render as renderSolid } from "@solidjs/web";
import { createComponent } from "solid-js";
import { vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { ChatPaneRuntimeView } from "./chat-pane-runtime-view.tsx";

export type PaneRuntimeConstructor<R extends ChatPaneRuntime> = new (
  element: HTMLElement,
  context: ApplicationContext,
) => R;

const paneTestRuntimes = new WeakMap<HTMLElement, ChatPaneRuntime>();

/** Keep the real owner behind legacy test access; browser DOM operations use .element. */
export function createPaneTestHost<R extends ChatPaneRuntime>(
  tag: string,
  Runtime: PaneRuntimeConstructor<R>,
  createContext: () => ApplicationContext,
): R & HTMLElement {
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
                  return createComponent(ChatPaneRuntimeView, { runtime });
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
            this.runtime.disconnectedCallback();
          }
        }
      },
    );
  }
  const element = document.createElement(tag);
  const runtime = paneTestRuntimes.get(element)!;
  const bound = new WeakMap<object, unknown>();
  const lifecycle = new Set(["connectedCallback", "disconnectedCallback"]);
  const owner = (key: PropertyKey) =>
    !lifecycle.has(String(key)) && (key in runtime || !(key in element)) ? runtime : element;
  const pane = new Proxy(element, {
    get(_target, key) {
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
      return Reflect.set(owner(key), key, value);
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
  // SAFETY: This test adapter forwards controller members and native DOM access to their owners.
  return pane as R & HTMLElement;
}

export function getPaneTestRuntime(pane: { element: HTMLElement }): ChatPaneRuntime {
  return paneTestRuntimes.get(pane.element)!;
}

/** Render-cadence tests use the real view with only its base connection lifecycle. */
export function connectPaneTestView(pane: { element: HTMLElement }) {
  const runtime = getPaneTestRuntime(pane);
  runtime.connectedCallback = () => ChatPaneBase.prototype.connectedCallback.call(runtime);
  runtime.disconnectedCallback = () => ChatPaneBase.prototype.disconnectedCallback.call(runtime);
  const connect: unknown = Reflect.get(pane.element, "connectedCallback");
  if (typeof connect === "function") {
    connect.call(pane.element);
  }
}
