import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { SessionBackground } from "../../components/session-background.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { AppearanceBackgroundController } from "./appearance-background-controller.ts";
import { AppearanceBackground as AppearanceBackgroundView } from "./view-appearance-background.tsx";

export type AppearanceBackgroundProps = { context?: ApplicationContext };

export function AppearanceBackground(props: AppearanceBackgroundProps) {
  let host!: HTMLElement;
  const context = createMemo(() => props.context ?? useApplication());
  // Plain controllers can notify while a descendant owns the current scope.
  const [revision, publish] = createSignal(0, { ownedWrite: true });
  const controller = new AppearanceBackgroundController(() => publish((value) => value + 1));
  let preview!: SessionBackground;
  const viewProps = createMemo(() => {
    revision();
    return controller.viewProps;
  });
  onSettled(() => {
    controller.attach(host, context());
  });
  createEffect(context, (current) => controller.connect(current));
  createEffect(revision, () => {
    controller.afterUpdate();
    // Reapply after a same-turn dismiss/reopen, as the former Lit live() binding did.
    preview.presented = controller.canvasPreview;
  });
  onCleanup(() => controller.dispose());
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
        preferenceOverride={(revision(), controller.previewPreference)}
      />
      <AppearanceBackgroundView {...viewProps()} />
    </openclaw-appearance-background>
  );
}
