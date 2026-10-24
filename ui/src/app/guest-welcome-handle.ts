import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type {
  GuestWelcome,
  GuestWelcomeOptions,
  GuestWelcomePresentation,
} from "./guest-welcome.ts";

/** Visitor Access plugin method; its presence in hello is the only feature gate. */
export const GUEST_WELCOME_ENSURE_METHOD = "visitor-access.welcome.ensure";

const HIDDEN: GuestWelcomePresentation = { kind: "hidden" };

/**
 * Startup handle for the guest welcome owner. Its code loads only once a Gateway
 * advertises the method, so other users never download it.
 */
export function createGuestWelcome(options: GuestWelcomeOptions) {
  let owner: GuestWelcome | undefined;
  let loading = false;
  let stopped = false;
  let stopOwner: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const load = async () => {
    if (
      loading ||
      isGatewayMethodAdvertised(options.gateway.snapshot, GUEST_WELCOME_ENSURE_METHOD) !== true
    ) {
      return;
    }
    loading = true;
    try {
      const { GuestWelcome } = await import("./guest-welcome.ts");
      if (!stopped) {
        owner = new GuestWelcome(options);
        owner.subscribe(() => listeners.forEach((listener) => listener()));
        stopOwner = owner.start();
      }
    } catch {
      // A failed chunk load retries on the next Gateway publication.
      loading = false;
    }
  };
  return {
    get presentation(): GuestWelcomePresentation {
      return owner?.presentation ?? HIDDEN;
    },
    retry: () => owner?.retry(),
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(): () => void {
      const stopGateway = options.gateway.subscribe(() => void load());
      void load();
      return () => {
        stopped = true;
        stopGateway();
        stopOwner?.();
      };
    },
  };
}

export type GuestWelcomeHandle = ReturnType<typeof createGuestWelcome>;
