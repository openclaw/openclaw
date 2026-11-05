import { createMemo, createSignal, lazy, onSettled, Show } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { createTimeout } from "../lib/reactive/timers.ts";
import { markdownTemplatePackage } from "./markdown-template-links.ts";

const ReferenceView = lazy(() => import("./template-reference-view.tsx"), {
  export: "TemplateReferenceView",
});

export type TemplateReference = {
  anchor: HTMLAnchorElement;
  packageName: string;
  client: GatewayBrowserClient;
  sessionKey: string;
};

/** Chat delegates intent; shared popover/modal primitives retain overlay ownership. */
export function createTemplateReferences(props: {
  application?: ApplicationContext;
  client?: GatewayBrowserClient | null;
  sessionKey: string;
}) {
  const [target, setTarget] = createSignal<TemplateReference | null>(null);
  const [modal, setModal] = createSignal<TemplateReference | null>(null);
  const current = (value: TemplateReference | null) =>
    value && value.client === props.client && value.sessionKey === props.sessionKey ? value : null;
  const active = createMemo(() => current(target()));
  const preview = createMemo(() => current(modal()));
  const close = createTimeout(() => setTarget(null), 180);
  function anchorFrom(event: Event) {
    return event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a.markdown-template-link")
      : null;
  }
  function reference(anchor: HTMLAnchorElement): TemplateReference | null {
    const packageName = markdownTemplatePackage(anchor.href, props.application?.basePath);
    return packageName && props.client && props.application
      ? { anchor, packageName, client: props.client, sessionKey: props.sessionKey }
      : null;
  }
  function activate(event: Event) {
    const anchor = anchorFrom(event);
    if (!anchor) {
      return;
    }
    close.cancel();
    if (active()?.anchor !== anchor) {
      setTarget(reference(anchor));
    }
  }
  function open(value: TemplateReference) {
    close.cancel();
    setTarget(null);
    setModal(value);
  }
  function View() {
    return (
      <Show when={Boolean(active() || preview())}>
        <ReferenceView
          application={props.application}
          active={active()}
          preview={preview()}
          onDismiss={() => setTarget(null)}
          onKeep={() => close.cancel()}
          onLeave={() => close.schedule()}
          onOpen={open}
          onClose={() => {
            const anchor = preview()?.anchor;
            setModal(null);
            onSettled(() => {
              if (anchor?.isConnected) {
                anchor.focus({ preventScroll: true });
              }
            });
          }}
        />
      </Show>
    );
  }
  return {
    View,
    onPointerOver: activate,
    onFocusIn: activate,
    onPointerOut: (event: PointerEvent) => {
      if (anchorFrom(event)) {
        close.schedule();
      }
    },
    onFocusOut: () => close.schedule(),
    onClick(event: MouseEvent) {
      if (!shouldHandleNavigationClick(event)) {
        return false;
      }
      const anchor = anchorFrom(event);
      const value = anchor && reference(anchor);
      if (!value) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      open(value);
      return true;
    },
  };
}
