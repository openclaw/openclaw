import { html } from "lit";
import { restoredInstantThreadPage } from "./instant-thread-restore.ts";
import "./new-session-page.tsx";

export const render = (data: unknown) =>
  restoredInstantThreadPage(data) ??
  html`<openclaw-new-session-page .data=${data}></openclaw-new-session-page>`;
