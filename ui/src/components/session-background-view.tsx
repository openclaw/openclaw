import { createEffect, createMemo } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import type { SessionBackground } from "./session-background.ts";

const renderer = createIdleImport(() => import("./session-background.ts"));

type Props = {
  context?: ApplicationContext;
  surface: "new-session" | "session";
  presented?: boolean;
};

/** Unset/None startup needs no image renderer, styles, transport, or geometry work. */
export function SessionBackgroundView(props: Props) {
  const theme = createMemo(() => props.context?.theme);
  const background = createMemo(() => {
    const source = theme();
    return source && projectOwner(source, (owner) => owner.settings.background);
  });
  const active = createMemo(() => {
    const preference = background()?.read();
    return Boolean(
      props.presented !== false &&
      preference &&
      preference.source.kind !== "none" &&
      preference.visibility > 0 &&
      (props.surface === "new-session" ? preference.showOnNewSession : preference.showInSessions),
    );
  });
  createEffect(active, (value) => {
    if (value) {
      void renderer.load().catch(() => undefined);
    }
  });
  return (
    <openclaw-session-background
      aria-hidden="true"
      hidden={!active()}
      prop:context={props.context}
      prop:surface={props.surface}
      prop:presented={props.presented !== false}
    />
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-session-background": HTMLAttributes<SessionBackground> & {
        "prop:context"?: ApplicationContext;
        "prop:surface"?: SessionBackground["surface"];
        "prop:presented"?: boolean;
      };
    }
  }
}
