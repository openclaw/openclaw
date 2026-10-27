import {
  sessionTitleAnchor,
  stampSessionTitleLabel,
  type SessionTitleDisplay,
} from "./session-title-label.ts";

// Producers can mount before the app's lazy hovercard bootstrap has loaded.
const { promise: registrar, resolve: installSessionTitleRegistrar } =
  Promise.withResolvers<
    (target: HTMLElement, label: HTMLElement, display?: SessionTitleDisplay) => () => void
  >();

export { installSessionTitleRegistrar };

export function registerSessionTitleTarget(
  target: HTMLElement,
  label: HTMLElement,
  display?: SessionTitleDisplay,
): () => void {
  const registeredTarget = display?.title ? sessionTitleAnchor(target, true) : target;
  if (display?.title) {
    stampSessionTitleLabel(registeredTarget, label, display.title);
  }
  let active = true;
  let release: (() => void) | undefined;
  void registrar.then((register) => {
    if (active) {
      release = display
        ? register(registeredTarget, label, display)
        : register(registeredTarget, label);
    }
  });
  return () => {
    active = false;
    release?.();
  };
}
