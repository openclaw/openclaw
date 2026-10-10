import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionBackground } from "../../components/session-background.ts";
import "../../components/session-background.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { AppearanceBackgroundController } from "./appearance-background-controller.ts";
import { AppearanceBackground as AppearanceBackgroundView } from "./view-appearance-background.tsx";

export type AppearanceBackgroundProps = { context?: ApplicationContext };

export function AppearanceBackgroundContent(props: AppearanceBackgroundProps) {
  const context = createMemo(() => props.context ?? useApplication());
  const [revision, publish] = createSignal(0);
  const controller = new AppearanceBackgroundController(() => publish((value) => value + 1));
  let preview: SessionBackground | undefined;
  const viewProps = createMemo(() => {
    revision();
    return controller.viewProps;
  });
  onSettled(() => {
    if (preview?.parentElement) {
      controller.attach(preview.parentElement, context());
    }
  });
  createEffect(context, (current) => controller.connect(current));
  createEffect(revision, () => controller.afterUpdate());
  onCleanup(() => controller.dispose());
  return (
    <>
      <openclaw-session-background
        ref={(element) => {
          preview = element;
        }}
        class="settings-background-preview"
        data-background-preview-canvas
        prop:context={context()}
        prop:surface="preview"
        prop:preferenceOverride={(revision(), controller.previewPreference)}
        prop:presented={(revision(), controller.canvasPreview)}
      />
      <AppearanceBackgroundView {...viewProps()} />
    </>
  );
}

export function AppearanceBackground(props: AppearanceBackgroundProps) {
  return (
    <openclaw-appearance-background>
      <AppearanceBackgroundContent {...props} />
    </openclaw-appearance-background>
  );
}
