import { createEffect } from "solid-js";

/** Keep the external admission observer bound through callback replacement and disposal. */
export function attachmentAdmissionRef(
  read: () => ((element: Element | undefined) => void) | undefined,
) {
  let element: Element;
  createEffect(read, (notify) => {
    notify?.(element);
    return () => notify?.(undefined);
  });
  return (node: Element) => (element = node);
}
