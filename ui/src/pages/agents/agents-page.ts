import { html } from "lit";
import "./agents-page.tsx";
import type { AgentsRouteData } from "./route.ts";

export const header = true;
export const render = (data: AgentsRouteData | undefined) =>
  html`<openclaw-agents-page .routeData=${data}></openclaw-agents-page>`;
