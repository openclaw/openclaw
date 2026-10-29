interface TransientModalHost extends HTMLElement {
  getOverlayContainer(): HTMLElement | null;
}

/** Keep transient UI inside the native modal's non-inert, separately owned range. */
export function resolveTransientContainer(
  ancestry: Iterable<EventTarget>,
  ownerDocument: Document,
): HTMLElement | null {
  const path = [...ancestry];
  const modal = path.find(
    (target): target is TransientModalHost =>
      target instanceof HTMLElement && target.localName === "openclaw-modal-dialog",
  );
  if (modal) {
    return modal.getOverlayContainer();
  }
  return (
    path.find(
      (target): target is HTMLDialogElement =>
        target instanceof HTMLDialogElement &&
        target.open &&
        target.getRootNode() === ownerDocument,
    ) ?? ownerDocument.body
  );
}
