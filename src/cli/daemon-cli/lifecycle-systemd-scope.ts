import {
  findInstalledSystemdGatewayScope,
  restartSystemdService,
  stopSystemdService,
} from "../../daemon/systemd.js";
import { createNullWriter } from "../../shared/null-writer.js";
import { createGatewayLifecycleMutationAudit } from "./lifecycle-audit.js";

export async function handleSystemScopeSystemdGateway(
  action: "stop",
): Promise<{ result: "stopped"; message: string } | null>;
export async function handleSystemScopeSystemdGateway(
  action: "restart",
): Promise<{ result: "restarted"; message: string } | null>;
export async function handleSystemScopeSystemdGateway(
  action: "stop" | "restart",
): Promise<{ result: "stopped" | "restarted"; message: string } | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const installed = await findInstalledSystemdGatewayScope(process.env).catch(() => null);
  if (installed?.scope !== "system") {
    return null;
  }
  const stdout = createNullWriter();
  const runAction = action === "stop" ? stopSystemdService : restartSystemdService;
  await runAction({
    stdout,
    env: process.env,
    onMutation: createGatewayLifecycleMutationAudit({ action }),
  });
  const result = action === "stop" ? "stopped" : "restarted";
  return {
    result,
    message: `Gateway ${result} via system-scope systemd unit ${installed.unitName}.`,
  };
}
