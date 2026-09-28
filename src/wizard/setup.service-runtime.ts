/** Localized onboarding choices for the shared Gateway runtime intent planner. */
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import { resolveGatewaySetupRuntime } from "../commands/gateway-setup-runtime.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import type { WizardFlow } from "./setup.types.js";

function getLocalizedGatewayDaemonRuntimeOptions() {
  return GATEWAY_DAEMON_RUNTIME_OPTIONS.map((option) => ({
    hint: t(
      option.value === "node"
        ? "wizard.finalize.daemonRuntimeNodeHint"
        : "wizard.finalize.daemonRuntimeBunHint",
    ),
    label: t(
      option.value === "node"
        ? "wizard.finalize.daemonRuntimeNode"
        : "wizard.finalize.daemonRuntimeBun",
    ),
    value: option.value,
  }));
}

export async function resolveOnboardingGatewayRuntime(params: {
  env: NodeJS.ProcessEnv;
  existingCommand: GatewayServiceCommandConfig | null;
  runtime?: GatewayDaemonRuntime;
  flow: WizardFlow;
  prompter: Pick<WizardPrompter, "select" | "note">;
}) {
  const selection = await resolveGatewaySetupRuntime({
    env: params.env,
    existingCommand: params.existingCommand,
    runtime: params.runtime,
    selectRuntime:
      params.flow === "quickstart"
        ? undefined
        : () =>
            params.prompter.select({
              message: t("wizard.finalize.daemonRuntime"),
              options: getLocalizedGatewayDaemonRuntimeOptions(),
              initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
            }),
  });
  if (
    params.flow === "quickstart" &&
    selection.runtime === "node" &&
    !selection.pinnedRuntimePath
  ) {
    await params.prompter.note(
      t("wizard.finalize.quickstartNodeRuntime"),
      t("wizard.finalize.daemonRuntime"),
    );
  }
  return selection;
}
