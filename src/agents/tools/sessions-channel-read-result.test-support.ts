import { resolveSessionStorePathCore } from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requestContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { bindSessionListRowRead } from "../../gateway/session-list-read-result.js";
import { bindSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../../gateway/session-row-projection.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";

type ChannelRow = {
  key: string;
  sessionId?: string;
  archivedAt?: number;
  chatType: "channel" | "group";
  space?: string;
  origin: { provider: string };
  deliveryContext: { channel: string; accountId: string; to: string };
};

/** Synthetic RPC rows and the production final-disclosure seam share one live row owner. */
export function createSessionChannelReadFixture(rows: readonly ChannelRow[]) {
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const entry = (row: ChannelRow): SessionEntry => ({
    sessionId: row.sessionId ?? row.key,
    updatedAt: 1,
    archivedAt: row.archivedAt,
    chatType: row.chatType,
    space: row.space,
    delivery: {
      kind: "external",
      route: {
        channel: row.deliveryContext.channel,
        accountId: row.deliveryContext.accountId,
        target: { to: row.deliveryContext.to, chatType: row.chatType },
      },
      context: row.deliveryContext,
      origin: { provider: row.origin.provider, chatType: row.chatType },
    },
  });
  const projection = createSessionRowProjectionFixture({
    cfg,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    store: Object.fromEntries(rows.map((row) => [row.key, entry(row)])),
  });
  const context = bindSessionRowProjection(requestContext(cfg), () => projection);
  for (const row of rows) {
    const record = projection.describe({ agentId: "main", key: row.key });
    if (!record) {
      throw new Error("Missing synthetic channel row");
    }
    bindSessionListRowRead(row, { projection, record });
  }
  return {
    projection,
    setRow: (row: ChannelRow) => projection.setEntry(row.key, entry(row)),
    run: <T>(run: () => Promise<T>): Promise<T> =>
      withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, run),
  };
}
