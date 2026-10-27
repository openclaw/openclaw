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
  if (display?.title) {
    target = sessionTitleAnchor(target, true);
    stampSessionTitleLabel(target, label, display.title);
  }
  let active = true;
  let release: (() => void) | undefined;
  void registrar.then((register) => {
    if (active) {
      release = display ? register(target, label, display) : register(target, label);
    }
  });
  return () => {
    active = false;
    release?.();
  };
}
