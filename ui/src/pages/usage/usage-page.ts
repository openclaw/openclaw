import { createComponent, createEffect, createMemo, createSignal } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import type { UsageRouteData } from "./types.ts";
import { UsagePageModel } from "./usage-page-model.ts";
import { UsagePageContent } from "./usage-page.tsx";

export const UsagePage = defineSolidBridge<{ routeData: UsageRouteData | undefined }>(
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
