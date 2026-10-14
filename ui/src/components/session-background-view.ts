import { html } from "lit";
import type { ApplicationContext } from "../app/context.ts";
import { createIdleImport } from "../lib/idle-import.ts";

const renderer = createIdleImport(() => import("./session-background.ts"));

/** Unset/None startup needs no image renderer, styles, transport, or geometry work. */
export function renderSessionBackground(
  context: ApplicationContext | undefined,
  surface: "new-session" | "session",
  presented = true,
) {
  const preference = context?.theme.settings.background;
  const active = Boolean(
    presented &&
    preference &&
    preference.source.kind !== "none" &&
    preference.visibility > 0 &&
    (surface === "new-session" ? preference.showOnNewSession : preference.showInSessions),
  );
  if (active) {
    void renderer.load().catch(() => undefined);
  }
  return html`<openclaw-session-background
    aria-hidden="true"
    ?hidden=${!active}
    .context=${context}
    .surface=${surface}
    .presented=${presented}
  ></openclaw-session-background>`;
}
