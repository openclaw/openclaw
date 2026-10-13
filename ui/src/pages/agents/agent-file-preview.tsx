import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, flush, onSettled, type Accessor } from "solid-js";
import type { OpenClawModalDialog } from "../../components/modal-dialog.ts";

type PreviewScope = readonly [agentId: string, fileName: string, loaded: boolean];

// Prepare each newly selected file once, then park the rendered snapshot while
// closed. The show event refreshes it before the modal takes focus.
export function AgentFilePreview<T>(props: {
  scope: PreviewScope;
  snapshot: () => T;
  children: (snapshot: Accessor<T>) => JSX.Element;
}) {
  let marker!: HTMLSpanElement;
  let modal: OpenClawModalDialog | null = null;
  let scope: PreviewScope | undefined;
  const [open, setOpen] = createSignal(false);
  const snapshot = createMemo((previous: T | undefined) => {
    const nextScope = props.scope;
    const changed = !scope || nextScope.some((value, index) => value !== scope?.[index]);
    scope = nextScope;
    const presented = open();
    return changed || presented ? props.snapshot() : previous!;
  });
  const show = (event: Event) => {
    if (event.target === modal) {
      setOpen(true);
      flush();
    }
  };
  const hide = (event: Event) => {
    if (event.target === modal) {
      setOpen(false);
      flush();
    }
  };
  onSettled(() => {
    modal = marker.closest<OpenClawModalDialog>("openclaw-modal-dialog");
    if (!modal) {
      throw new Error("Agent file preview must be a modal child");
    }
    setOpen(modal.open);
    modal.addEventListener("wa-show", show);
    modal.addEventListener("wa-hide", hide);
    return () => {
      modal?.removeEventListener("wa-show", show);
      modal?.removeEventListener("wa-hide", hide);
    };
  });
  return (
    <span
      ref={(element) => {
        marker = element;
      }}
      style={{ display: "contents" }}
    >
      {props.children(snapshot)}
    </span>
  );
}
