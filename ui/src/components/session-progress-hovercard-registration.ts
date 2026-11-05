import {
  hovercardBootstrapIntentActive,
  LazyHovercardBootstrap,
  type HovercardBootstrapTrigger,
} from "./lazy-hovercard-registration.ts";
import { installSessionTitleRegistrar } from "./markdown-link-display.ts";
import { sessionProgressHoverTargetFromEvent } from "./session-progress-hovercard-target.ts";
import type { SessionProgressHovercardProvider } from "./session-progress-hovercard.runtime.tsx";

const HOVERCARD_TAG = "openclaw-session-progress-hovercard-provider";

const bootstrap = new LazyHovercardBootstrap<SessionProgressHovercardProvider>({
  tag: HOVERCARD_TAG,
  load: async () => {
    await import("./session-progress-hovercard.runtime.tsx");
    return customElements.get(HOVERCARD_TAG)!;
  },
});

installSessionTitleRegistrar((target, label, display) => {
  let active = true;
  let release: (() => void) | undefined;
  // The registrar promise lets producers finish mounting before this lookup.
  const provider = bootstrap.providerFor(target);
  if (provider) {
    void bootstrap
      .define()
      .then(async () => {
        await provider.updateComplete;
        if (active && target.isConnected && bootstrap.providerFor(target) === provider) {
          release = provider.registerSessionTitleTarget(target, label, display);
        }
      })
      .catch(() => undefined);
  }
  return () => {
    active = false;
    release?.();
  };
});

async function activateHovercard(event: Event, trigger: HovercardBootstrapTrigger): Promise<void> {
  if (
    trigger === "pointer" &&
    ((event instanceof PointerEvent && event.pointerType === "touch") ||
      !globalThis.matchMedia?.("(hover: hover)").matches)
  ) {
    return;
  }
  const target = sessionProgressHoverTargetFromEvent(event);
  if (!target || !bootstrap.providerFor(target)) {
    return;
  }
  await bootstrap.define();
  const eventTarget = event.target;
  if (
    !(eventTarget instanceof EventTarget) ||
    !target.isConnected ||
    !hovercardBootstrapIntentActive(target, trigger, true)
  ) {
    return;
  }
  eventTarget.dispatchEvent(
    new Event(trigger === "pointer" ? "pointerover" : "focusin", {
      bubbles: true,
      composed: true,
    }),
  );
}

// The native link/title remains usable when optional hovercard code cannot load.
bootstrap.install((event, trigger) => activateHovercard(event, trigger).catch(() => undefined));
