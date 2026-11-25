import type { RouteLocation } from "@openclaw/uirouter";
import { createMemo, onSettled } from "solid-js";
import {
  findControlUiSetting,
  type ControlUiSettingId,
} from "../../../../src/shared/control-ui-settings/index.ts";
import { sameRouteLocation } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { createPendingSettingsTarget } from "../settings-target-arrival.ts";
import { useOptionalApplication } from "./context.ts";
import { projectOwner } from "./projection.ts";

/** How long a page may take to render the linked setting before the link is dropped. */
const TARGET_WAIT_MS = 10_000;

function decodeTarget(hash: string): string | null {
  try {
    return decodeURIComponent(hash.slice(1)) || null;
  } catch {
    return null;
  }
}

/** The linked row, for lazy lists that must render its contents before arrival. */
export function createSettingsTargetId(): () => string | null {
  const context = useOptionalApplication();
  return context
    ? projectOwner(
        context.router,
        (router) => decodeTarget(router.getState().location.hash),
        Object.is,
      ).read
    : () => null;
}

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
    // The route outlet mounts before Settings content; without it there is nothing to watch.
    if (!root) {
      return () => {};
    }
    const pending = createPendingSettingsTarget(() => root);
    // Rows that depend on Gateway reads render after the route does.
    const observer = new MutationObserver(() => pending.commit());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: RouteLocation | undefined;
    const follow = () => {
      const next = props.router.getState().location;
      // Ignore loader-only notifications, not another agent or panel with the same row ID.
      if (sameRouteLocation(next, previous)) {
        return;
      }
      previous = next;
      observer.disconnect();
      clearTimeout(timer);
      const targetId = decodeTarget(next.hash);
      pending.request(targetId);
      if (targetId) {
        pending.commit();
        observer.observe(root, { childList: true, subtree: true, attributeFilter: ["id"] });
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
  const target = createSettingsTargetId();
  return createMemo(() => {
    const id = target();
    for (let place = id ? findControlUiSetting(id) : undefined; place?.entry.within;) {
      if (place.entry.within === disclosure) {
        return true;
      }
      place = findControlUiSetting(place.entry.within);
    }
    return false;
  });
}
