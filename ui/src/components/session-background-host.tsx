import { createMemo, createSignal, lazy, onSettled, Show } from "solid-js";
import type { BackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { ApplicationContext } from "../app/context.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { SessionBackgroundLayoutTarget } from "./session-background-layout-context.tsx";
import { createSidebarRendererLoader } from "./sidebar-renderer-loader.tsx";

export type SessionBackgroundSurface = "new-session" | "session" | "preview";
export type SessionBackgroundProps = {
  context?: ApplicationContext;
  surface: SessionBackgroundSurface;
  presented: boolean;
  preferenceOverride?: BackgroundPreference;
  layoutTargets?: readonly SessionBackgroundLayoutTarget[];
};
export type SessionBackground = SolidBridgeElement<SessionBackgroundProps>;

const Content = lazy(() => import("./session-background.tsx"), {
  export: "SessionBackgroundContent",
});
const renderer = createSidebarRendererLoader(async () => {
  await Content.preload();
});
const Boundary = renderer.Boundary;

/** Share visibility between the retained slot and native lazy content admission. */
export function createBackgroundActivation(
  props: Omit<SessionBackgroundProps, "presented" | "layoutTargets"> & { presented?: boolean },
  fallbackContext?: ApplicationContext | null,
) {
  const theme = createMemo(() => (props.context ?? fallbackContext)?.theme);
  const background = createMemo(() => {
    const source = theme();
    return source && projectOwner(source, (owner) => owner.settings.background);
  });
  return createMemo(() => {
    const preference =
      props.surface === "preview"
        ? (props.preferenceOverride ?? background()?.read())
        : background()?.read();
    return Boolean(
      props.presented !== false &&
      preference &&
      preference.source.kind !== "none" &&
      preference.visibility > 0 &&
      (props.surface === "preview" ||
        (props.surface === "new-session"
          ? preference.showOnNewSession
          : preference.showInSessions)),
    );
  });
}

/** Keep native properties available before the first decoration needs its renderer. */
export const SessionBackground = defineSolidBridge<SessionBackgroundProps>(
  "openclaw-session-background",
  (props, host) => {
    const active = createBackgroundActivation(props, useOptionalApplication());
    // Keep the image owner and its subscriptions once this host has shown a background.
    const [activated] = createSignal<boolean>((previous) => previous === true || active());
    return (
      <Show when={activated()}>
        {(_active) => {
          onSettled(() => {
            void renderer.load().catch(() => undefined);
          });
          return (
            <Boundary>
              <Content {...props} host={host} />
            </Boundary>
          );
        }}
      </Show>
    );
  },
  {
    properties: {
      context: { default: undefined, attribute: false },
      surface: { default: "session", attribute: false },
      presented: { default: true, attribute: false },
      preferenceOverride: { default: undefined, attribute: false },
      layoutTargets: { default: undefined, attribute: false },
    },
  },
);
