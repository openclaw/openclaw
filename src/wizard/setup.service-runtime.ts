import { GATEWAY_DAEMON_RUNTIME_OPTIONS } from "../commands/daemon-runtime.js";
import { t } from "./i18n/index.js";

export function getLocalizedGatewayDaemonRuntimeOptions() {
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
