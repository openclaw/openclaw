import { createMemo, onSettled } from "solid-js";
import {
  findControlUiSetting,
  type ControlUiSettingId,
} from "../../../../src/shared/control-ui-settings/index.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { createPendingSettingsTarget } from "../settings-target-arrival.ts";
import { useOptionalApplication } from "./context.ts";
import { projectOwner } from "./projection.ts";

/** How long a page may take to render the linked setting before the link is dropped. */
const TARGET_WAIT_MS = 10_000;

/**
 * Brings the setting named by the route's `#<setting-id>` into view inside `host` once the
 * page has rendered it. The Settings shell mounts one for every Settings page.
 */
export function SettingsTargetArrival(props: {
  router: ApplicationContext["router"];
  host: () => HTMLElement | undefined;
}): null {
  onSettled(() => {
    const root = props.host();
    if (!root) {
      return;
    }
    const pending = createPendingSettingsTarget(() => root);
    // Rows that depend on Gateway reads render after the route does.
    const observer = new MutationObserver(() => pending.commit());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hash: string | undefined;
    const follow = () => {
      const next = props.router.getState().location.hash;
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
    const stopRoute = props.router.subscribe(follow);
    return () => {
      stopRoute();
      observer.disconnect();
      clearTimeout(timer);
      pending.dispose();
    };
  });
  return null;
}

/**
 * Whether the route's `#<setting-id>` names a setting inside `disclosure`, so the disclosure
 * opens for the link instead of hiding its target. Outside the application it never opens.
 */
export function createSettingsTargetReveal(disclosure: ControlUiSettingId): () => boolean {
  const context = useOptionalApplication();
  if (!context) {
    return () => false;
  }
  const router = projectOwner(context.router, (source) => source.getState().location.hash);
  return createMemo(() => {
    let id: string | undefined;
    try {
      id = decodeURIComponent(router.read().slice(1));
    } catch {
      return false;
    }
    for (let place = id ? findControlUiSetting(id) : undefined; place?.entry.within;) {
      if (place.entry.within === disclosure) {
        return true;
      }
      place = findControlUiSetting(place.entry.within);
    }
    return false;
  });
}
