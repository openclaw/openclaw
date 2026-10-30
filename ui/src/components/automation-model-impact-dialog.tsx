import { lazy, Loading } from "solid-js";
import type { CronModelImpactResult } from "../../../packages/gateway-protocol/src/schema/cron-model-impact.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";

const AutomationModelImpactDialog = lazy(() => import("./automation-model-impact-view.tsx"), {
  export: "AutomationModelImpactDialog",
});

export function showAutomationModelImpactDialog(
  impact: CronModelImpactResult,
  options: { canConfirm: () => boolean; signal: AbortSignal },
): Promise<boolean> {
  return withPromiseModalHost({ signal: options.signal, value: false }, ({ render, finish }) => {
    // Like other promise modals, mount readiness before the save action can hold its first frame.
    render(() => (
      <Loading>
        <AutomationModelImpactDialog
          impact={impact}
          canConfirm={options.canConfirm}
          finish={finish}
        />
      </Loading>
    ));
    return AutomationModelImpactDialog.preload().then(() => undefined);
  });
}
