import type { JSX } from "@solidjs/web";

export type ModalDialogContentProps = {
  label: string;
  description: string;
  children?: JSX.Element;
  bindDialog: (element: HTMLDialogElement) => void;
  bindOverlayContainer: (element: HTMLElement) => void;
};

/** The caller's content range and transient overlays have separate DOM owners. */
export function ModalDialogContent(props: ModalDialogContentProps) {
  return (
    <dialog
      ref={props.bindDialog}
      class="oc-modal-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={props.label || undefined}
      aria-description={props.description || undefined}
    >
      <div class="oc-modal-dialog__body">{props.children}</div>
      <div ref={props.bindOverlayContainer} class="oc-modal-dialog__overlay-content" />
    </dialog>
  );
}
