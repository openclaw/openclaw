import { onSettled } from "solid-js";
import { createPendingSettingsTarget } from "../settings-target-arrival.ts";
import { useApplication } from "./context.ts";

/** How long a page may take to render the linked setting before the link is dropped. */
const TARGET_WAIT_MS = 10_000;

/**
 * Brings the setting named by the route's `#<setting-id>` into view inside `host`, once it
 * has rendered. For pages whose own state does not already follow the route hash.
 */
export function createSettingsTargetArrival(host: () => HTMLElement): void {
  const context = useApplication();
  onSettled(() => {
    const root = host();
    const pending = createPendingSettingsTarget(() => root);
    // Rows that depend on Gateway reads render after the route does.
    const observer = new MutationObserver(() => pending.commit());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hash: string | undefined;
    const follow = () => {
      const next = context.router.getState().location.hash;
      // The router publishes for every loader step; only a different fragment is a new arrival.
      if (next === hash) {
        return;
      }
      hash = next;
      observer.disconnect();
      clearTimeout(timer);
      let targetId: string | null = null;
      try {
        targetId = decodeURIComponent(next.slice(1)) || null;
      } catch {
        // A malformed fragment names no setting.
      }
      pending.request(targetId);
      if (targetId) {
        pending.commit();
        observer.observe(root, { childList: true, subtree: true });
        timer = setTimeout(() => observer.disconnect(), TARGET_WAIT_MS);
      }
    };
    follow();
    const stopRoute = context.router.subscribe(follow);
    return () => {
      stopRoute();
      observer.disconnect();
      clearTimeout(timer);
      pending.dispose();
    };
  });
}
