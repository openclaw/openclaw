import { render, spread, type JSX } from "@solidjs/web";
import { nothing, render as renderLit } from "lit";
import {
  createComponent,
  createEffect,
  createRenderEffect,
  createSignal,
  flush,
  onCleanup,
  runWithOwner,
} from "solid-js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { shellLayoutOwnerForHost } from "../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../app/shell-layout-traits-solid.tsx";
import { ApplicationProvider } from "../lib/reactive/context.ts";

type Property<T> = {
  default: T;
  attribute?: string | false;
  type?: StringConstructor | NumberConstructor | BooleanConstructor;
  reflect?: boolean;
};

export type SolidBridgeElement<Props, Methods = object> = HTMLElement &
  Props &
  Methods & {
    readonly updateComplete: Promise<boolean>;
  };

type Spec<Props, Methods> = {
  properties: { [Key in keyof Props]-?: Property<Props[Key]> };
  connected?(host: SolidBridgeElement<Props, Methods>): void;
  disconnected?(host: SolidBridgeElement<Props, Methods>): void;
  methods?: {
    [Key in keyof Methods]: Methods[Key] extends (...args: infer Args) => infer Result
      ? (host: SolidBridgeElement<Props, Methods>, ...args: Args) => Result
      : never;
  };
};

type ComponentProps<Props, Methods> = Partial<Props> &
  Omit<JSX.HTMLAttributes<SolidBridgeElement<Props, Methods>>, keyof Props> & {
    children?: JSX.Element;
  };

/** Interim tag owner: delete with the last Lit caller at the Solid cutover. */
export function defineSolidBridge<Props extends object, Methods extends object = object>(
  tag: string,
  content: (
    props: Props & { children?: JSX.Element },
    host: SolidBridgeElement<Props, Methods>,
  ) => JSX.Element,
  spec: Spec<Props, Methods>,
) {
  const properties = Object.entries<Property<unknown>>(spec.properties);
  const defaults = Object.fromEntries(
    properties.map(([key, property]) => [key, property.default]),
  ) as Props; // SAFETY: spec.properties maps every Props key to its typed default.
  const declarations = new Map(properties);
  const attributes = new Map(
    properties.flatMap(([key, property]) =>
      property.attribute === false ? [] : [[property.attribute ?? key.toLowerCase(), key]],
    ),
  );

  class BridgeElement extends HTMLElement {
    static observedAttributes = [...attributes.keys()];
    #values = new Map(properties.map(([key, property]) => [key, property.default]));
    #upgraded = new Map<string, unknown>();
    #notify?: () => void;
    #dispose?: () => void;
    #unsubscribe?: () => void;
    #application?: ApplicationContext;
    #mountedApplication?: ApplicationContext;
    #content?: DocumentFragment;
    #start?: Comment;
    #pending?: Promise<boolean>;
    #solidOwned = false;
    #host: SolidBridgeElement<Props, Methods>;

    constructor() {
      super();
      const methods = Object.fromEntries(
        Object.entries(spec.methods ?? {}).map(([key, method]) => {
          if (typeof method !== "function") {
            throw new TypeError(`Bridge method ${key} must be a function`);
          }
          return [
            key,
            (...args: unknown[]) => Reflect.apply(method, undefined, [this.#host, ...args]),
          ];
        }),
      ) as Methods; // SAFETY: Callers declare all Methods; wrappers forward the typed host and arguments.
      const upgraded = properties.filter(([key]) => Object.hasOwn(this, key));
      for (const [key] of upgraded) {
        this.#upgraded.set(key, Reflect.get(this, key));
        Reflect.deleteProperty(this, key);
      }
      for (const [key] of properties) {
        Object.defineProperty(this, key, {
          configurable: true,
          get: () => this.#values.get(key),
          set: (value: unknown) => this.#write(key, value),
        });
      }
      this.#host = Object.assign(this, defaults, methods);
    }

    get updateComplete(): Promise<boolean> {
      return this.#pending ?? Promise.resolve(true);
    }

    #write(key: string, value: unknown) {
      if (Object.is(this.#values.get(key), value)) {
        return;
      }
      this.#values.set(key, value);
      const property = declarations.get(key);
      if (property?.reflect && property.attribute !== false) {
        const attribute = property.attribute ?? key.toLowerCase();
        if (value == null || value === false) {
          this.removeAttribute(attribute);
        } else if (value === true || typeof value === "string" || typeof value === "number") {
          this.setAttribute(attribute, value === true ? "" : String(value));
        } else {
          throw new TypeError(`Cannot reflect non-primitive bridge property ${key}`);
        }
      }
      this.#notify?.();
      void this.#commit();
    }

    attributeChangedCallback(name: string, _old: string | null, value: string | null) {
      const key = attributes.get(name)!;
      const property = declarations.get(key)!;
      const type =
        property.type ??
        (typeof property.default === "boolean"
          ? Boolean
          : typeof property.default === "number"
            ? Number
            : String);
      this.#write(
        key,
        type === Boolean
          ? value !== null
          : type === Number && value !== null
            ? Number(value)
            : value,
      );
    }

    connectedCallback() {
      if (this.#solidOwned) {
        spec.connected?.(this.#host);
        return;
      }
      for (const [key, value] of this.#upgraded) {
        this.#write(key, value);
      }
      this.#upgraded.clear();
      spec.connected?.(this.#host);
      this.#connectContext();
    }

    #connectContext() {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#application = undefined;
      this.dispatchEvent(
        Object.assign(new Event("context-request", { bubbles: true, composed: true }), {
          context: applicationContext,
          contextTarget: this,
          subscribe: true,
          callback: (value: ApplicationContext, unsubscribe?: () => void) => {
            if (this.#unsubscribe !== unsubscribe) {
              this.#unsubscribe?.();
            }
            this.#application = value;
            this.#unsubscribe = unsubscribe;
            void this.#commit();
          },
        }),
      );
      void this.#commit();
    }

    disconnectedCallback() {
      spec.disconnected?.(this.#host);
      if (!this.#solidOwned) {
        // Reparenting within a turn keeps the root (and the live sidebar) intact.
        queueMicrotask(() => {
          if (!this.isConnected) {
            this.#disposeRoot();
          }
        });
      }
    }

    #commit() {
      return (this.#pending ??= Promise.resolve().then(() => {
        this.#pending = undefined;
        if (this.isConnected && !this.#solidOwned) {
          if (this.#dispose && this.#application !== this.#mountedApplication) {
            this.#disposeRoot();
            this.#connectContext();
          }
          if (!this.#dispose) {
            runWithOwner(null, () => this.#mount());
          }
        }
        // Queued during Lit's property commit, before its updateComplete reactions.
        // Never flush reentrantly from a Solid render/effect callback.
        flush();
        return true;
      }));
    }

    #mount(children?: () => JSX.Element) {
      let source: JSX.Element;
      if (!this.#solidOwned) {
        if (!this.#content) {
          this.#content = this.ownerDocument.createDocumentFragment();
          this.#start = this.ownerDocument.createComment("solid-bridge-content");
          this.#content.append(this.#start, ...this.childNodes);
        }
        source = [...this.#content.childNodes];
      }
      this.#mountedApplication = this.#application;
      const layout = !this.#solidOwned ? shellLayoutOwnerForHost(this) : undefined;
      this.#dispose = render(() => {
        const [revision, setRevision] = createSignal(0);
        this.#notify = () => setRevision((value) => value + 1);
        const props = {
          ...defaults,
          get children() {
            return children ? children() : source;
          },
        };
        for (const [key] of properties) {
          Object.defineProperty(props, key, {
            get: () => {
              revision();
              return this.#values.get(key);
            },
          });
        }
        const renderContent = () => content(props, this.#host);
        const view = () =>
          layout
            ? createComponent(ShellLayoutProvider, {
                value: { owner: layout, host: this },
                get children() {
                  return renderContent();
                },
              })
            : renderContent();
        return this.#application
          ? createComponent(ApplicationProvider, {
              value: this.#application,
              get children() {
                return view();
              },
            })
          : view();
      }, this);
    }

    #disposeRoot() {
      this.#notify = undefined;
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      const outlet = this.#start?.parentNode;
      if (this.#content && outlet && outlet !== this.#content) {
        // A final Lit ChildPart has no end marker and can append to this outlet.
        this.#content.append(...outlet.childNodes);
      }
      this.#dispose?.();
      this.#dispose = undefined;
      this.#application = undefined;
      this.#mountedApplication = undefined;
    }

    static render(props: ComponentProps<Props, Methods>): JSX.Element {
      const host = new BridgeElement();
      host.#solidOwned = true;
      spread(host, props, true, (key) => declarations.has(key));
      const absent = Symbol("absent bridge property");
      for (const [key, property] of properties) {
        createRenderEffect(
          () => (Reflect.has(props, key) ? Reflect.get(props, key) : absent),
          (value) => {
            if (value !== absent) {
              host.#write(key, value === undefined ? property.default : value);
            }
          },
        );
      }
      host.#mount(() => props.children);
      onCleanup(() => host.#disposeRoot());
      return host;
    }
  }
  customElements.define(tag, BridgeElement);

  return Object.assign(
    function SolidBridge(props: ComponentProps<Props, Methods>): JSX.Element {
      return BridgeElement.render(props);
    },
    {
      // SAFETY: The constructor materializes every declared property and method above.
      Element: BridgeElement as (new () => SolidBridgeElement<Props, Methods>) &
        typeof BridgeElement,
    },
  );
}

/** Unported stateless templates exclusively own this adapter's descendants. */
export function LitContent(props: { render: () => unknown }) {
  const host = document.createElement("span");
  host.style.display = "contents";
  let part: ReturnType<typeof renderLit> | undefined;
  createEffect(
    () => props.render(),
    (template) => {
      part = renderLit(template, host, { host });
    },
  );
  onCleanup(() => {
    part?.setConnected(false);
    renderLit(nothing, host);
  });
  return host;
}
