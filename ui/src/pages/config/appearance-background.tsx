import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import "../../components/session-background.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { AppearanceBackgroundController } from "./appearance-background-controller.ts";
import { AppearanceBackground as AppearanceBackgroundView } from "./view-appearance-background.tsx";

export type AppearanceBackgroundProps = { context?: ApplicationContext };

export function AppearanceBackgroundContent(
  props: AppearanceBackgroundProps & { host: HTMLElement },
) {
  const context = createMemo(() => props.context ?? useApplication());
  // Plain controllers can notify while a descendant or bridge owns the current scope.
  const [revision, publish] = createSignal(0, { ownedWrite: true });
  const controller = new AppearanceBackgroundController(() => publish((value) => value + 1));
  const viewProps = createMemo(() => {
    revision();
    return controller.viewProps;
  });
  onSettled(() => {
    controller.attach(props.host, context());
  });
  createEffect(context, (current) => controller.connect(current));
  createEffect(revision, () => controller.afterUpdate());
  onCleanup(() => controller.dispose());
  return (
    <>
      <openclaw-session-background
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

export const AppearanceBackground = defineSolidBridge<AppearanceBackgroundProps>(
  "openclaw-appearance-background",
  (props, host) => <AppearanceBackgroundContent {...props} host={host} />,
  { properties: { context: { default: undefined, attribute: false } } },
);
