import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { listGroups, searchGroups } from "../../web/group-metadata.js";
import { jsonResult, readStringParam } from "./common.js";

export async function handleWhatsAppListGroups(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const query = readStringParam(params, "query");
  const groups = query ? await searchGroups(query) : await listGroups();
  const configuredGroups = cfg.channels?.whatsapp?.groups ?? {};

  const result = Array.from(groups.entries()).map(([jid, meta]) => {
    const groupCfg = configuredGroups[jid];
    return {
      jid,
      name: groupCfg?.name ?? meta.subject,
      isCommunity: meta.isCommunity,
      linkedParent: meta.linkedParent,
      configuredAs: groupCfg?.requireMention,
    };
  });

  return jsonResult(result);
}
