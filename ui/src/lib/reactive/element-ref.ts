import { onCleanup } from "solid-js";

/** Native DOM refs resolve inside a ref array: ref={[elementRef(props.onElement)]}. */
export function elementRef<T extends Element>(
  register: ((element: T) => void | (() => void)) | undefined,
): (element: T) => void {
  let release: void | (() => void);
  onCleanup(() => release?.());
  return (element) => {
    release = register?.(element);
  };
}
