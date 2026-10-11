import { render as renderSolid } from "@solidjs/web";
import { html, nothing, render as renderLit } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import {
  createComponent,
  createMemo,
  getOwner,
  runWithOwner,
  createRenderEffect,
  createSignal,
  flush,
  onCleanup,
  untrack,
  type Component,
  type Accessor,
} from "solid-js";

function createProjectedProps<P extends object>(read: Accessor<P>): P {
  const owner = getOwner();
  const values = new Map<PropertyKey, Accessor<unknown>>();
  const presence = new Map<PropertyKey, Accessor<boolean>>();
  const value = (key: PropertyKey) => {
    let projection = values.get(key);
    if (!projection) {
      projection = runWithOwner(owner, () => createMemo(() => Reflect.get(read(), key)));
      values.set(key, projection);
    }
    return projection();
  };
  const has = (key: PropertyKey) => {
    let projection = presence.get(key);
    if (!projection) {
      projection = runWithOwner(owner, () => createMemo(() => Reflect.has(read(), key)));
      presence.set(key, projection);
    }
    return projection();
  };
  const keys = createMemo(() => Reflect.ownKeys(read()), {
    equals: (previous, next) =>
      previous.length === next.length && previous.every((key, index) => key === next[index]),
  });
  // Each consumer tracks only its field; unrelated props must not rewrite native inputs.
  // The proxy owns no snapshot; its traps supply every field from the current source.
  const current = new Proxy({} as P, {
    get: (_target, key) => value(key),
    has: (_target, key) => has(key),
    ownKeys: () => keys(),
    getOwnPropertyDescriptor: (_target, key) =>
      has(key)
        ? {
            configurable: true,
            enumerable: true,
            value: value(key),
          }
        : undefined,
  });
  return current;
}

// The unported callers own Lit parts; each adapter owns only its own contents.
class SolidTemplateDirective extends AsyncDirective {
  private element?: HTMLSpanElement;
  private component?: unknown;
  private latestProps: object = {};
  private dispose?: () => void;
  private updateProps?: (props: object) => void;
  private mount?: () => void;

  render<P extends object>(component: Component<P>, props: P) {
    this.element ??= document.createElement("span");
    this.element.style.display = "contents";
    if (this.component !== component) {
      this.dispose?.();
      this.dispose = undefined;
      this.component = component;
    }
    this.latestProps = props;
    this.mount = () => {
      // render() pairs this snapshot with the component's P before every mount.
      const [read, write] = createSignal(this.latestProps as P, { equals: false });
      this.updateProps = (next) => write(() => next as P);
      this.dispose = renderSolid(
        () => createComponent(component, createProjectedProps(read)),
        this.element!,
      );
    };
    if (this.isConnected) {
      if (!this.dispose) {
        this.mount?.();
      }
      this.updateProps?.(props);
      flush();
    }
    return this.element;
  }

  protected disconnected() {
    this.dispose?.();
    this.dispose = undefined;
    this.updateProps = undefined;
  }

  protected reconnected() {
    this.mount?.();
    flush();
  }
}

const solidDirective = directive(SolidTemplateDirective);

export function solidTemplate<P extends object>(component: Component<P>, props: P) {
  return html`${solidDirective(component, props)}`;
}

/** Opaque content remains with its existing Lit owner until that caller is ported. */
export function LitContent(props: { value: unknown }) {
  let element: HTMLSpanElement | undefined;
  createRenderEffect(
    () => props.value,
    (value) => {
      if (element) {
        renderLit(value ?? nothing, element);
      }
    },
  );
  onCleanup(() => {
    if (element) {
      renderLit(nothing, element);
    }
  });
  return (
    <span
      style={{ display: "contents" }}
      ref={(node) => {
        element = node;
        renderLit(untrack(() => props.value) ?? nothing, node);
      }}
    />
  );
}
