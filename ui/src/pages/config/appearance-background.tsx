import { SessionBackground } from "../../components/session-background.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { createAppearanceBackground } from "./appearance-background-state.ts";
import { AppearanceBackground as AppearanceBackgroundView } from "./view-appearance-background.tsx";

export function AppearanceBackground() {
  let host!: HTMLElement;
  const context = useApplication();
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
        context={context}
        surface="preview"
        presented={state.previewPresented()}
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
