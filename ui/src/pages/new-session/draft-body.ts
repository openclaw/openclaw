import { createComponent } from "solid-js";
import { LitContent, solidContent, type LegacyTemplateResult } from "../../lit/solid-content.tsx";
import { NewSessionBody, type NewSessionBodyProps } from "./draft-body.solid.tsx";

export function renderNewSessionBody(
  options: Omit<NewSessionBodyProps, "renderDraft"> & { renderDraft: () => LegacyTemplateResult },
) {
  return solidContent(NewSessionBody, {
    ...options,
    renderDraft: () => createComponent(LitContent, { value: options.renderDraft() }),
  });
}
