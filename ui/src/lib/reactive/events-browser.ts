import type { RouterHistory } from "@openclaw/uirouter";
import {
  readNativeBrowserState,
  subscribeNativeBrowserState,
  type NativeBrowserState,
} from "../../app/native-browser-bridge.ts";
import { getLobsterdexEntries, subscribeLobsterdex } from "../../components/lobster-dex.ts";
import {
  subscribeTranscriptScroll,
  type TranscriptScrollObservation,
} from "../../pages/chat/components/chat-transcript-scroll-events.ts";
import { subscribeNativeOverlayOcclusion } from "../native-overlay-occlusion.ts";
import { projectEvents, projectSource } from "./projection.ts";

/** History owns popstate; programmatic navigation publication belongs to the router. */
export function projectBrowserHistory(source: RouterHistory) {
  return projectSource(source, {
    read: (history) => history.location(),
    subscribe: (history, notify) => history.listen(notify),
    equality: (left, right) =>
      left.pathname === right.pathname && left.search === right.search && left.hash === right.hash,
  });
}

export type NativeBrowserSource = {
  read: typeof readNativeBrowserState;
  subscribe: typeof subscribeNativeBrowserState;
};

export function projectNativeBrowserState(
  source: NativeBrowserSource = {
    read: readNativeBrowserState,
    subscribe: subscribeNativeBrowserState,
  },
) {
  let observed: { source: NativeBrowserSource; state: NativeBrowserState } | undefined;
  return projectSource(source, {
    read: (current) => (observed?.source === current ? observed.state : current.read()),
    subscribe: (current, notify) => {
      let active = true;
      const release = current.subscribe((state) => {
        if (!active) {
          return;
        }
        observed = { source: current, state };
        notify();
      });
      return () => {
        active = false;
        release();
        if (observed?.source === current) {
          observed = undefined;
        }
      };
    },
    equality: "revision",
  });
}

export type NativeOverlayOcclusionSource = { getBounds: () => DOMRectReadOnly | null };

export function projectNativeOverlayOcclusion(source: NativeOverlayOcclusionSource) {
  return projectSource(source, {
    read: (current) => {
      // This owner publishes an initial value through subscribe, without a getter.
      let occluded = false;
      const release = subscribeNativeOverlayOcclusion((value) => {
        occluded = value;
      }, current.getBounds);
      release();
      return occluded;
    },
    subscribe: (current, notify) => subscribeNativeOverlayOcclusion(notify, current.getBounds),
    equality: Object.is,
  });
}

export function projectLobsterdex() {
  return projectSource(
    { read: getLobsterdexEntries, subscribe: subscribeLobsterdex },
    {
      read: (source) => source.read(),
      subscribe: (source, notify) => source.subscribe(notify),
      equality: "revision",
    },
  );
}

export function projectTranscriptScroll(source: HTMLElement) {
  return projectEvents<HTMLElement, TranscriptScrollObservation>(source, {
    subscribe: subscribeTranscriptScroll,
  });
}
