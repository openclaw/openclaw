import { html } from "lit";
import { solidContent } from "../lit/solid-content.tsx";
import { ConnectingSplash } from "./solid/loading-skeleton.tsx";

export function renderConnectingSplash(status?: string) {
  return html`${solidContent(ConnectingSplash, { status })}`;
}
