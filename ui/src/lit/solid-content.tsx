import { insert, render as renderSolid, type JSX } from "@solidjs/web";
import { nothing, render as renderLit } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import type { Part } from "lit/directive.js";
import {
  createComponent,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  flush,
  getOwner,
  onCleanup,
  runWithOwner,
  useContext,
  untrack,
  type Accessor,
  type Component,
} from "solid-js";
import { ContentPresentation as SolidContentPresentation } from "../lib/solid/presentation.ts";

export type { TemplateResult as LegacyTemplateResult } from "lit";
export type { DirectiveResult as LegacyDirectiveResult } from "lit/directive.js";

export const emptyLegacyContent: typeof nothing = nothing;

type LitContentMount = {
  update: (value: unknown) => void;
  nodes: () => Node[];
  setConnected: (connected: boolean) => void;
  dispose: () => void;
};

type NestedSolidRoot = { element: HTMLElement; dispose: () => void };
let currentLitRoots: Set<NestedSolidRoot> | undefined;
const litContentMounts = new WeakMap<HTMLElement | DocumentFragment, LitContentMount>();

/** A top-level Lit caller settles now; nested Solid work settles with its owner. */
function flushLegacyContent(): void {
  if (!getOwner() && !currentLitRoots) {
    flush();
  }
}

/** One retained Lit range owns each legacy content container. */
function mountLitContent(
  value: unknown,
  container: HTMLElement | DocumentFragment,
  options: { isConnected?: boolean; host?: object } = {},
): LitContentMount {
  const existing = litContentMounts.get(container);
  if (existing) {
    existing.update(value);
    return existing;
  }
  const end = document.createComment("lit-content");
  container.append(end);
  const owner = getOwner();
  const renderOptions = { ...options, renderBefore: end };
  const roots = new Set<NestedSolidRoot>();
  // Restore the creator for nested resources; keep the handoff marked so those
  // roots register here without starting a reentrant flush.
  const commit = <T,>(run: () => T): T => {
    const previous = currentLitRoots;
    currentLitRoots = roots;
    try {
      return runWithOwner(owner, run);
    } finally {
      currentLitRoots = previous;
    }
  };
  const part = commit(() => renderLit(value, container, renderOptions));
  let ownedNodes: Node[] = [];
  const readOwnedNodes = (): Node[] => {
    const start = part.startNode;
    if (!start?.parentNode || start.parentNode !== end.parentNode) {
      return ownedNodes;
    }
    const nodes: Node[] = [];
    for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
      nodes.push(node);
    }
    return nodes;
  };
  ownedNodes = readOwnedNodes();
  let disposed = false;
  const mount: LitContentMount = {
    update(next) {
      commit(() => renderLit(next, container, renderOptions));
      ownedNodes = readOwnedNodes();
      // Lit does not notify a second disconnection when parked content is removed.
      for (const root of roots) {
        if (
          !root.element.isConnected &&
          root.element.getRootNode() !== part.startNode?.getRootNode()
        ) {
          root.dispose();
        }
      }
    },
    nodes() {
      const nodes = [...readOwnedNodes()];
      if (part.startNode) {
        nodes.unshift(part.startNode);
      }
      nodes.push(end);
      return nodes;
    },
    setConnected: (connected) => commit(() => part.setConnected(connected)),
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      const nodes = readOwnedNodes();
      runWithOwner(null, () => part.setConnected(false));
      for (const root of roots) {
        root.dispose();
      }
      // Solid can remove the markers first. Retire remaining template roots
      // directly instead of rendering into an already-detached ChildPart.
      for (const node of nodes) {
        node.parentNode?.removeChild(node);
      }
      part.startNode?.parentNode?.removeChild(part.startNode);
      end.remove();
      litContentMounts.delete(container);
    },
  };
  litContentMounts.set(container, mount);
  return mount;
}

/** A marker range preserves the direct-child selectors of unported templates. */
export function LitContent(props: { value: unknown }): JSX.Element {
  const presented = useContext(SolidContentPresentation);
  const fragment = document.createDocumentFragment();
  // Initial nodes can be handed through a legacy template before Solid commits.
  const mount = mountLitContent(
    untrack(() => props.value),
    fragment,
    {
      isConnected: untrack(presented),
    },
  );
  const [nodes, setNodes] = createSignal(mount.nodes(), { ownedWrite: true });
  createEffect(
    () => ({ value: props.value, active: presented() }),
    ({ value, active }) => {
      if (!active) {
        mount.setConnected(false);
      }
      mount.update(value);
      // Keep the pending handoff current; Lit owns mutations after the range is inserted.
      if (fragment.hasChildNodes()) {
        setNodes(mount.nodes());
      }
      // Catch up props while disconnected before restarting retained directives.
      if (active) {
        mount.setConnected(true);
      }
    },
  );
  onCleanup(mount.dispose);
  return <>{nodes()}</>;
}

class SolidContent extends AsyncDirective {
  private readonly owner = getOwner();
  private element?: HTMLSpanElement;
  private component?: Component<Record<string, unknown>>;
  private props: Record<string, unknown> = {};
  private updateProps?: (props: Record<string, unknown>) => void;
  private updatePresented?: (presented: boolean) => void;
  private dispose?: () => void;
  private roots = currentLitRoots;
  private root?: NestedSolidRoot;

  render(_component: Component<Record<string, unknown>>, _props: Record<string, unknown>) {
    return this.element ?? nothing;
  }

  override update(
    _part: Part,
    [component, props]: [Component<Record<string, unknown>>, Record<string, unknown>],
  ) {
    if (this.component !== component) {
      this.disposeRoot();
      this.component = component;
    }
    this.roots ??= currentLitRoots;
    this.props = props;
    this.element ??= Object.assign(document.createElement("span"), {
      style: "display: contents",
    });
    if (!this.isConnected) {
      return this.element;
    }
    if (this.dispose) {
      this.updateProps?.(props);
      flushLegacyContent();
    } else {
      this.mount();
    }
    return this.element;
  }

  private mount() {
    const component = this.component;
    const element = this.element;
    if (!component || !element) {
      return;
    }
    const owner = this.owner ?? getOwner();
    const view = () => {
      // Legacy hosts can reuse mutable props and publish during a parent's Solid commit.
      const [props, setProps] = createSignal(this.props, { ownedWrite: true, equals: false });
      const [presented, setPresented] = createSignal(this.isConnected, { ownedWrite: true });
      this.updateProps = (next) => setProps(() => next);
      this.updatePresented = setPresented;
      const projectionOwner = getOwner();
      const values = new Map<PropertyKey, Accessor<unknown>>();
      const presence = new Map<PropertyKey, Accessor<boolean>>();
      const value = (key: PropertyKey) => {
        let projection = values.get(key);
        if (!projection) {
          projection = runWithOwner(projectionOwner, () =>
            createMemo(() => Reflect.get(props(), key), {
              // Legacy callers mutate nested objects and getter closures in place.
              equals: (previous, next) =>
                (next === null || (typeof next !== "object" && typeof next !== "function")) &&
                Object.is(previous, next),
            }),
          );
          values.set(key, projection);
        }
        return projection();
      };
      const has = (key: PropertyKey) => {
        let projection = presence.get(key);
        if (!projection) {
          projection = runWithOwner(projectionOwner, () =>
            createMemo(() => Reflect.has(props(), key)),
          );
          presence.set(key, projection);
        }
        return projection();
      };
      const keys = createMemo(() => Reflect.ownKeys(props()), {
        equals: (previous, next) =>
          previous.length === next.length && previous.every((key, index) => key === next[index]),
      });
      // Unrelated props must not rewrite native input values or selection.
      const liveProps = new Proxy<Record<string, unknown>>(
        {},
        {
          get: (_target, key) => value(key),
          has: (_target, key) => has(key),
          ownKeys: () => keys(),
          getOwnPropertyDescriptor: (_target, key) =>
            has(key) ? { configurable: true, enumerable: true, value: value(key) } : undefined,
        },
      );
      return (
        <SolidContentPresentation value={presented}>
          {createComponent(component, liveProps)}
        </SolidContentPresentation>
      );
    };
    // Nested top-level rendering can flush effects under the parent's render owner.
    this.dispose = runWithOwner(owner, () =>
      owner || currentLitRoots
        ? createRoot((dispose) => {
            insert(element, view());
            return () => {
              dispose();
              element.replaceChildren();
            };
          })
        : renderSolid(view, element),
    );
    this.root = { element, dispose: () => this.disposeRoot() };
    this.roots?.add(this.root);
  }

  private disposeRoot() {
    this.dispose?.();
    this.dispose = undefined;
    this.updateProps = undefined;
    this.updatePresented = undefined;
    if (this.root) {
      this.roots?.delete(this.root);
      this.root = undefined;
    }
  }

  protected override disconnected() {
    this.updatePresented?.(false);
    // A parked Lit range is still in the DOM. Keep its Solid controls and local
    // state; actual removal happens after Lit notifies its directives.
    queueMicrotask(() => {
      if (!this.isConnected && !this.element?.isConnected) {
        this.disposeRoot();
      }
    });
  }

  protected override reconnected() {
    if (this.dispose) {
      this.updateProps?.(this.props);
      this.updatePresented?.(true);
    } else {
      this.mount();
    }
  }
}

const renderSolidContent = directive(SolidContent);

/** A stable component receives new props without replacing its owned DOM. */
export function solidContent<P extends Record<string, unknown>>(component: Component<P>, props: P) {
  // SAFETY: The directive passes this same P value to its paired component; only the generic is erased.
  return renderSolidContent(component as Component<Record<string, unknown>>, props);
}
