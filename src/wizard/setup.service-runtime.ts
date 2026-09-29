/** Localized onboarding choices for the shared Gateway runtime intent planner. */
import {
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
  prompter: Pick<WizardPrompter, "select">;
}) {
  return resolveGatewaySetupRuntime({
    env: params.env,
    existingCommand: params.existingCommand,
    runtime: params.runtime,
    selectRuntime:
      params.flow === "quickstart"
        ? undefined
        : (suggested) =>
            params.prompter.select({
              message: t("wizard.finalize.daemonRuntime"),
              options: getLocalizedGatewayDaemonRuntimeOptions(),
              initialValue: suggested,
            }),
  });
}
