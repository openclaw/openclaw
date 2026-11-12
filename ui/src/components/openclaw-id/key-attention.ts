import type { ApplicationContext } from "../../app/context-types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { t } from "../../i18n/index.ts";
import { openClawIdAccount } from "../../lib/openclaw-id/account.ts";
import type { OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { showToast } from "../../lib/toast.ts";
import { showMoveKeysDialog } from "./move-keys-dialog.tsx";

/** Re-read the connection before opening recovery; the inbox is only a presentation snapshot. */
export async function openSidebarKeyRecovery(context: ApplicationContext): Promise<void> {
  const client = context.gateway.snapshot.client;
  if (!client || !context.config.current.openclawIdEnabled) {
    return;
  }
  const revision = context.gateway.connectionRevision;
  const scope = gatewayPresentationScope(context.gateway);
  const status = await client.request<OpenClawIdStatusResult>("openclawId.status", {});
  if (
    context.gateway.snapshot.client !== client ||
    context.gateway.connectionRevision !== revision ||
    gatewayPresentationScope(context.gateway) !== scope ||
    context.gateway.snapshot.phase !== "connected" ||
    !context.config.current.openclawIdEnabled ||
    status.channel !== "local_operator" ||
    status.status.state === "off" ||
    !status.link.linked ||
    !status.link.hostname
  ) {
    return;
  }
  const signedIn = openClawIdAccount();
  if (!signedIn) {
    showToast({ severity: "info", message: t("openclawId.keyRecoverySignIn") });
    return;
  }
  await showMoveKeysDialog({ client, signedIn, hostname: status.link.hostname });
}
