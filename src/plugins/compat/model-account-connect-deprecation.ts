import { warnSessionPersistenceDeprecation } from "../../agents/sessions/session-persistence-deprecation.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";

export function warnModelAccountConnectDeprecation(
  method: "listLinks" | "link" | "unlink" | "list" | "select" | "status" | "cancel",
): void {
  const pluginId = pluginInstanceInvocation.getStore()?.instance.pluginId;
  warnSessionPersistenceDeprecation(
    `modelAccountConnectService.${method}`,
    `modelAccountConnectService.${method}Async`,
    { pluginId, family: "model-account-connect" },
  );
}
