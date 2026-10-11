import { render as renderSolid, type JSX } from "@solidjs/web";
import { nothing, render as renderLit } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import type { Part } from "lit/directive.js";
import {
  createComponent,
  createContext,
  createEffect,
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

export type { TemplateResult as LegacyTemplateResult } from "lit";

/** Retained content keeps its DOM while foreground directive work is disconnected. */
export const SolidContentPresentation = createContext<Accessor<boolean>>(() => true);

export const emptyLegacyContent = nothing;

type LitContentMount = {
  update: (value: unknown) => void;
  nodes: () => Node[];
  setConnected: (connected: boolean) => void;
  dispose: () => void;
};

const litContentMounts = new WeakMap<HTMLElement | DocumentFragment, LitContentMount>();

/** One retained Lit range owns each legacy content container. */
export function mountLitContent(
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
  const renderOptions = { ...options, renderBefore: end };
  // Legacy directives own their signal writes, independently of the calling Solid effect.
  const commit = (next: unknown) =>
    runWithOwner(null, () => renderLit(next, container, renderOptions));
  const part = commit(value);
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
      commit(next);
      ownedNodes = readOwnedNodes();
    },
    nodes() {
      const nodes = [...readOwnedNodes()];
      if (part.startNode) {
        nodes.unshift(part.startNode);
      }
      nodes.push(end);
      return nodes;
    },
    setConnected: (connected) => runWithOwner(null, () => part.setConnected(connected)),
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      const nodes = readOwnedNodes();
      runWithOwner(null, () => part.setConnected(false));
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
  private element?: HTMLSpanElement;
  private component?: Component<Record<string, unknown>>;
  private props: Record<string, unknown> = {};
  private updateProps?: (props: Record<string, unknown>) => void;
  private dispose?: () => void;

  render(_component: Component<Record<string, unknown>>, _props: Record<string, unknown>) {
    return this.element ?? nothing;
  }

  override update(
    _part: Part,
    [component, props]: [Component<Record<string, unknown>>, Record<string, unknown>],
  ) {
    if (this.component !== component) {
      this.dispose?.();
      this.dispose = undefined;
      this.component = component;
    }
    this.props = props;
    this.element ??= Object.assign(document.createElement("span"), {
      style: "display: contents",
    });
    if (!this.isConnected) {
      return this.element;
    }
    if (this.dispose) {
      this.updateProps?.(props);
      if (!getOwner()) {
        flush();
      }
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
    // This directive owns the root, independently of a surrounding Solid effect.
    this.dispose = runWithOwner(null, () =>
      renderSolid(() => {
        // A legacy host can publish props during its parent's Solid commit.
        const [props, setProps] = createSignal(this.props, { ownedWrite: true });
        this.updateProps = (next) => setProps(() => next);
        const liveProps = new Proxy<Record<string, unknown>>(
          {},
          {
            get: (_target, key: string) => props()[key],
            has: (_target, key: string) => key in props(),
            ownKeys: () => Reflect.ownKeys(props()),
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
          },
        );
        return createComponent(component, liveProps);
      }, element),
    );
  }

  protected override disconnected() {
    this.dispose?.();
    this.dispose = undefined;
    this.updateProps = undefined;
  }

  protected override reconnected() {
    this.mount();
  }
}

const renderSolidContent = directive(SolidContent);

/** A stable component receives new props without replacing its owned DOM. */
export function solidContent<P extends Record<string, unknown>>(component: Component<P>, props: P) {
  // SAFETY: The directive passes this same P value to its paired component; only the generic is erased.
  return renderSolidContent(component as Component<Record<string, unknown>>, props);
}
