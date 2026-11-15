import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerOpenClawIdEnglish } from "../i18n/locales/en-openclaw-id.ts";
import type {
  OpenClawIdPeopleLink,
  OpenClawIdPublication,
  OpenClawIdStatusResult,
} from "../lib/openclaw-id/types.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";

registerOpenClawIdEnglish();

function buildOpenClawIdKeyAttention(
  status: OpenClawIdStatusResult,
  publication?: OpenClawIdPublication | null,
): SidebarAttentionItem | null {
  if (status.channel !== "local_operator" || !status.link.linked || status.status.state === "off") {
    return null;
  }
  const refused = status.status.state === "keys_refused";
  if (!refused && !(publication?.state === "failed" && publication.code === "binding_superseded")) {
    return null;
  }
  return {
    type: "attention",
    category: "system",
    kind: "openClawIdKeys",
    severity: "error",
    icon: "key",
    requiresAction: true,
    dismissal: null,
    signature: JSON.stringify([
      status.link.clawId,
      refused ? status.status.reason : "binding_superseded",
    ]),
    label: t(
      refused
        ? status.status.reason === "key_mismatch"
          ? "openclawId.keysMismatch"
          : "openclawId.keysMissing"
        : "openclawId.bindingSuperseded",
    ),
    detail: t(refused ? "openclawId.keysRefusedDetail" : "openclawId.bindingSupersededDetail"),
    action: { kind: "openClawIdRecovery", label: t("openclawId.moveToNewKeys") },
  };
}

export async function readOpenClawIdKeyAttention(
  client: GatewayBrowserClient,
  current: () => boolean,
): Promise<SidebarAttentionItem | null> {
  const status = await client.request<OpenClawIdStatusResult>("openclawId.status", {});
  if (!current()) {
    return null;
  }
  const publication =
    status.status.state !== "keys_refused" &&
    status.channel === "local_operator" &&
    status.owner &&
    status.link.linked
      ? (await client.request<{ link: OpenClawIdPeopleLink }>("openclawId.people", {})).link
          .publication
      : null;
  return buildOpenClawIdKeyAttention(status, publication);
}
