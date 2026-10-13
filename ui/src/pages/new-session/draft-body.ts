import { html } from "lit";
import { createComponent } from "solid-js";
import { LitContent, solidContent, type LegacyTemplateResult } from "../../lit/solid-content.tsx";
import {
  NewSessionBody,
  newSessionAnnouncement,
  type NewSessionBodyProps,
} from "./draft-body.solid.tsx";

export function renderNewSessionBody(
  options: Omit<NewSessionBodyProps, "renderDraft"> & { renderDraft: () => LegacyTemplateResult },
) {
  // Retained Lit hosts keep their live region outside the Solid directive's wrapper.
  return html`<div class="sr-only" role="status" aria-live="polite">
      ${newSessionAnnouncement(options)}
    </div>
    ${solidContent(NewSessionBody, {
      ...options,
      hideAnnouncement: true,
      renderDraft: () => createComponent(LitContent, { value: options.renderDraft() }),
    })}`;
}
