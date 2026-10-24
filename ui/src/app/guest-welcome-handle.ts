import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { ApplicationGateway } from "./gateway.ts";

/** Visitor Access plugin method; its presence in hello is the only feature gate. */
export const GUEST_WELCOME_ENSURE_METHOD = "visitor-access.welcome.ensure";

/** Hidden covers idle, the first in-flight call, ready, and not applicable. */
export type GuestWelcomePresentation =
  | { kind: "hidden" }
  | { kind: "pending" }
  | { kind: "failed"; message: string | null };

export type GuestWelcomeOptions = {
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe" | "connection">;
  /** True only while the guest still sits on the default Home landing, never a deep link. */
  isHomeLanding: () => Promise<boolean>;
  openSession: (sessionKey: string, agentId: string) => void;
};

type GuestWelcomeOwner = {
  readonly presentation: GuestWelcomePresentation;
  retry(): void;
  subscribe(listener: () => void): () => void;
  start(): () => void;
};

const HIDDEN: GuestWelcomePresentation = { kind: "hidden" };

/**
 * Startup handle for the guest welcome owner. Its code loads only once a Gateway
 * advertises the method, so other users never download it. Keep this module a leaf:
 * the owner imports its contract from here.
 */
export function createGuestWelcome(options: GuestWelcomeOptions) {
  let owner: GuestWelcomeOwner | undefined;
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
