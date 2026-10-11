import { solidContent } from "../../lit/solid-content.tsx";
import { LibraryPinRead, type LibraryPinReadProps } from "./library-detail.tsx";

/** The unported chat capability host retains this read-only dialog boundary. */
export function renderLibraryPinRead(props: LibraryPinReadProps) {
  return html`${solidContent(LibraryPinRead, props)}`;
}
import { html } from "lit";
