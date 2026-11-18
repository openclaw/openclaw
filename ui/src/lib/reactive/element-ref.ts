import { onCleanup } from "solid-js";

/** A replaceable DOM slot; retiring an older binding must not clear its replacement. */
export function connectedElementRef<T extends Element>() {
  let current: T | undefined;
  return {
    read: () => (current?.isConnected ? current : null),
    bind: (element: T) => {
      current = element;
      return () => {
        if (current === element) {
          current = undefined;
        }
      };
    },
  };
}

/** Native DOM refs resolve inside a ref array: ref={[elementRef(props.onElement)]}. */
export function elementRef<T extends Element>(
  register: ((element: T) => void | (() => void)) | undefined,
): (element: T) => void {
  let release: void | (() => void);
  onCleanup(() => release?.());
  return (element) => {
    release?.();
    release = register?.(element);
  };
}
