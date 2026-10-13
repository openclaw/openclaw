import { html } from "lit";
import { createComponent, createEffect, createMemo, createSignal } from "solid-js";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import type { UsageRouteData } from "./types.ts";
import { UsagePageModel } from "./usage-page-model.ts";
import { UsagePageContent } from "./usage-page.tsx";

defineSolidBridge<{ routeData: UsageRouteData | undefined }>(
  "openclaw-usage-page",
  (props) => {
    const context = useApplication();
    const [revision, setRevision] = createSignal(0);
    const model = new UsagePageModel(context, () => setRevision((value) => value + 1));
    const state = createMemo(() => {
      revision();
      return model.read();
    });
    createEffect(
      () => context,
      () => {
        model.connect();
        return () => model.dispose();
      },
    );
    createEffect(
      () => props.routeData,
      (data) => model.setRouteData(data),
    );
    return createComponent(UsagePageContent, {
      get state() {
        return state();
      },
      context,
      get result() {
        revision();
        return model.usageResult;
      },
    });
  },
  { properties: { routeData: { default: undefined, attribute: false } } },
);

// The legacy router still emits Lit; its host is owned by the Solid bridge.
export const usagePageComponent = {
  header: true,
  render: (data: UsageRouteData | undefined) =>
    html`<openclaw-usage-page
      .routeData=${data}
      ${shellLayoutTraits({
        toolbarHeader: true,
        settingsPage: true,
        settingsWide: true,
        settingsWorkspace: true,
      })}
    ></openclaw-usage-page>`,
};
