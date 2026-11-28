import { useContext } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { createBackgroundActivation, SessionBackground } from "./session-background-host.tsx";
import { SessionBackgroundLayoutContext } from "./session-background-layout-context.tsx";

type Props = {
  context?: ApplicationContext;
  surface: "new-session" | "session";
  presented?: boolean;
};

/** Unset/None startup needs no image renderer, styles, transport, or geometry work. */
export function SessionBackgroundView(props: Props) {
  const layout = useContext(SessionBackgroundLayoutContext);
  const active = createBackgroundActivation(props);
  return (
    <SessionBackground
      aria-hidden="true"
      hidden={!active()}
      context={props.context}
      surface={props.surface}
      presented={props.presented !== false}
      layoutTargets={layout?.targets()}
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
        "prop:layoutTargets"?: SessionBackground["layoutTargets"];
      };
    }
  }
}
