import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import {
  formatGatewayServiceInspectionErrors,
  gatewayServiceCleanupHintLabel,
  renderGatewayServiceCleanupHints,
} from "../../daemon/inspect.js";
import type { DaemonStatus } from "./status.gather.js";

export function printExtraGatewayServices(
  status: Pick<DaemonStatus, "extraServices" | "extraServiceInspectionErrors">,
  out: {
    log: (line: string) => void;
    error: (line: string) => void;
    warnText: (line: string) => string;
    infoText: (line: string) => string;
    errorText: (line: string) => string;
  },
): void {
  for (const line of formatGatewayServiceInspectionErrors(status.extraServiceInspectionErrors)) {
    out.error(out.errorText(line));
  }
  if (status.extraServices.length === 0) {
    return;
  }
  out.log(out.warnText("Other gateway-like services detected (best effort):"));
  for (const service of status.extraServices) {
    out.log(
      `- ${out.warnText(terminalText`${service.label}`)} ${terminalText`(${service.scope}, ${service.detail})`}`,
    );
  }
  for (const service of status.extraServices) {
    for (const hint of renderGatewayServiceCleanupHints([service])) {
      out.log(`${out.infoText(gatewayServiceCleanupHintLabel(hint))} ${hint}`);
    }
  }
  out.log("");
}
