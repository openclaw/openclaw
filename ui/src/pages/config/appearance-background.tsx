import { createMemo } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { SessionBackground } from "../../components/session-background.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { createAppearanceBackground } from "./appearance-background-state.ts";
import { AppearanceBackground as AppearanceBackgroundView } from "./view-appearance-background.tsx";

export type AppearanceBackgroundProps = { context?: ApplicationContext };

export function AppearanceBackground(props: AppearanceBackgroundProps) {
  let host!: HTMLElement;
  const context = createMemo(() => props.context ?? useApplication());
  let preview!: SessionBackground;
  let fileInput: HTMLInputElement | undefined;
  const state = createAppearanceBackground(
    context,
    () => host,
    () => preview,
    () => fileInput,
  );
  return (
    <openclaw-appearance-background ref={(element) => (host = element)}>
      <SessionBackground
        class="settings-background-preview"
        data-background-preview-canvas
        ref={(element: SessionBackground) => {
          preview = element;
        }}
        context={context()}
        surface="preview"
        preferenceOverride={state.previewPreference()}
      />
      <AppearanceBackgroundView
        {...state.viewProps()}
        fileRef={(element) => {
          fileInput = element;
        }}
      />
    </openclaw-appearance-background>
  );
}
