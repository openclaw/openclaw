import { insert, render, spread } from "@solidjs/web";
import { createRoot, createSignal, onCleanup } from "solid-js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { registerRouteElement } from "../app/route-elements.ts";
import { shellLayoutOwnerForHost } from "../app/shell-layout-owner.ts";
import type { JSX } from "../types/solid-elements.d.ts";
import { renderSolidBridgeView } from "./solid-bridge-view.tsx";

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
  connected?: (host: SolidBridgeElement<Props, Methods>) => void;
  disconnected?: (host: SolidBridgeElement<Props, Methods>) => void;
  propertyChanged?: (host: SolidBridgeElement<Props, Methods>, key: keyof Props) => void;
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

/** One native custom-element host for imperative and Solid callers. */
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
  ) as Props; // SAFETY: The property map materializes every declared key.
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
    #publish = new Map<string, () => void>();
    #dispose?: () => void;
    #unsubscribe?: () => void;
    #unregisterRouteElement?: () => void;
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
      ) as Methods; // SAFETY: Each declared method is validated and bound to this host.
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
      // SAFETY: Keys come only from spec.properties, which maps every Props key.
      spec.propertyChanged?.(this.#host, key as keyof Props);
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
      this.#publish.get(key)?.();
      if (!this.#solidOwned) {
        void this.#commit();
      }
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
      Reflect.set(
        this,
        key,
        type === Boolean
          ? value !== null
          : type === Number && value !== null
            ? Number(value)
            : value,
      );
    }

    connectedMoveCallback() {
      // Atomic parking keeps the existing provider and owned child tree.
      this.#registerRouteElement();
    }

    #registerRouteElement() {
      this.#unregisterRouteElement?.();
      this.#unregisterRouteElement = registerRouteElement(this);
    }

    connectedCallback() {
      this.#registerRouteElement();
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
      this.#unregisterRouteElement?.();
      this.#unregisterRouteElement = undefined;
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
            this.#mount();
          }
        }
        return true;
      }));
    }

    #mount(children?: () => JSX.Element) {
      let source: JSX.Element;
      if (!this.#solidOwned) {
        if (!this.#content) {
          this.#content = this.ownerDocument.createDocumentFragment();
          this.#start = this.ownerDocument.createComment("solid-bridge-content");
          this.prepend(this.#start);
        } else {
          this.append(...this.#content.childNodes);
        }
        // Adopt passthrough children in place so lazy upgrade keeps focus and hover intent.
        source = [...this.childNodes];
      }
      this.#mountedApplication = this.#application;
      const layout = !this.#solidOwned ? shellLayoutOwnerForHost(this) : undefined;
      const view = () => {
        // Spreading defaults can let V8 retain old view getters through shared descriptors.
        const props: Record<string, unknown> = {};
        for (const [key] of properties) {
          // Wrap callable values so Solid treats callbacks as data, not computations.
          const [value, setValue] = createSignal(
            { value: this.#values.get(key) },
            { ownedWrite: true, equals: (left, right) => Object.is(left.value, right.value) },
          );
          this.#publish.set(key, () => setValue({ value: this.#values.get(key) }));
          Object.defineProperty(props, key, {
            enumerable: true,
            configurable: true,
            get: () => {
              value();
              return this.#values.get(key);
            },
          });
        }
        if (!declarations.has("children")) {
          Object.defineProperty(props, "children", {
            enumerable: true,
            configurable: true,
            get: () => (children ? children() : source),
          });
        }
        return renderSolidBridgeView(
          // SAFETY: Each declared property was materialized with its live getter above.
          () => content(props as Props & { children?: JSX.Element }, this.#host),
          this.#application,
          layout,
          this,
        );
      };
      // A nested top-level render would flush child effects under the parent's render owner.
      this.#dispose = this.#solidOwned
        ? createRoot((dispose) => {
            insert(this, view());
            return dispose;
          })
        : render(view, this, source);
    }

    #disposeRoot() {
      this.#publish.clear();
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      const outlet = this.#start?.parentNode;
      if (this.#content && outlet && outlet !== this.#content) {
        // Caller-owned nodes may be appended to the outlet after mounting.
        this.#content.append(...outlet.childNodes);
      }
      this.#dispose?.();
      if (this.#solidOwned) {
        this.replaceChildren();
      }
      this.#dispose = undefined;
      this.#application = undefined;
      this.#mountedApplication = undefined;
    }

    static render(props: ComponentProps<Props, Methods>): JSX.Element {
      const host = new BridgeElement();
      host.#solidOwned = true;
      // The renderer owns property binding timing, including the first mount.
      spread(
        host,
        () => {
          const bindings: Record<string, unknown> = {};
          for (const key of Object.keys(props)) {
            if (key !== "children" && !declarations.has(key)) {
              bindings[key] = Reflect.get(props, key);
            }
          }
          for (const [key, property] of properties) {
            const value = Reflect.has(props, key)
              ? Reflect.get(props, key)
              : Reflect.get(host, key);
            bindings[`prop:${key}`] = value === undefined ? property.default : value;
          }
          return bindings;
        },
        true,
      );
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
