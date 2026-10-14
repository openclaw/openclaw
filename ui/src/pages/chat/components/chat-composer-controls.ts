import { render as renderSolid } from "@solidjs/web";
import { html, nothing, render as renderLit } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import {
  createComponent,
  createMemo,
  getOwner,
  runWithOwner,
  createSignal,
  flush,
  type Component,
  type Accessor,
} from "solid-js";
import { renderKbd } from "../../../components/kbd.ts";

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
  // SAFETY: All keys and property reads come from the current P through these traps.
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

type MountContent = (read: Accessor<object>, element: HTMLElement) => () => void;

// The unported callers own Lit parts; each adapter owns only its own contents.
class SolidTemplateDirective extends AsyncDirective {
  private element?: HTMLSpanElement;
  private component?: unknown;
  private latestProps: object = {};
  private dispose?: () => void;
  private updateProps?: (props: object) => void;
  private mount?: () => void;
  private commitQueued = false;

  private commit() {
    if (!this.isConnected) {
      return;
    }
    runWithOwner(null, () => {
      if (!this.dispose) {
        this.mount?.();
      }
      this.updateProps?.(this.latestProps);
      flush();
    });
  }

  private requestCommit() {
    if (this.commitQueued) {
      return;
    }
    // A nested Lit commit must not flush an independent root inside a Solid render.
    if (getOwner()) {
      this.commitQueued = true;
      queueMicrotask(() => {
        this.commitQueued = false;
        this.commit();
      });
    } else {
      this.commit();
    }
  }

  render(component: unknown, props: object, mountContent: MountContent) {
    this.element ??= document.createElement("span");
    this.element.style.display = "contents";
    if (this.component !== component) {
      runWithOwner(null, () => this.dispose?.());
      this.dispose = undefined;
      this.component = component;
    }
    this.latestProps = props;
    this.mount = () => {
      const [read, write] = createSignal<object>(() => this.latestProps, { equals: false });
      this.updateProps = (next) => write(() => next);
      this.dispose = mountContent(read, this.element!);
    };
    if (this.isConnected) {
      this.requestCommit();
    }
    return this.element;
  }

  protected override disconnected() {
    runWithOwner(null, () => this.dispose?.());
    this.dispose = undefined;
    this.updateProps = undefined;
  }

  protected override reconnected() {
    this.requestCommit();
  }
}

const solidDirective = directive(SolidTemplateDirective);

export function solidTemplate<P extends object>(component: Component<P>, props: P) {
  const mountContent: MountContent = (read, element) => {
    const readProps = (): P => {
      // SAFETY: This factory pairs the component with its P-typed props for every update.
      return read() as P;
    };
    return renderSolid(() => createComponent(component, createProjectedProps(readProps)), element);
  };
  return html`${solidDirective(component, props, mountContent)}`;
}

export function renderComposerContent(value: unknown, container: HTMLElement): void {
  renderLit(value ?? nothing, container);
}

export function hasComposerContent(value: unknown): boolean {
  return value != null && value !== false && value !== "" && value !== nothing;
}

export function renderComposerSendTooltip(label: string, alternate: string, modifier: string) {
  return html`${label}${" "}${renderKbd("⏎", { inline: true })}${" · "}${alternate}${" "}${renderKbd(modifier.split(/(⌘)/u).filter(Boolean), { inline: true })}`;
}
