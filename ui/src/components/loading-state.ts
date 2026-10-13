import { html } from "lit";
import { solidContent } from "../lit/solid-content.tsx";
import { LoadingState } from "./solid/loading-state.tsx";

export function renderLoadingState() {
  return html`${solidContent(LoadingState, {})}`;
}
