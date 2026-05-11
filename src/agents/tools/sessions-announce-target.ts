import type { CallGatewayOptions } from "../../gateway/call.js";
import { normalizeOptionalStringifiedId } from "../../shared/string-coerce.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { SessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";

async function callGatewayLazy<T = unknown>(opts: CallGatewayOptions): Promise<T> {
  const { callGateway } = await import("../../gateway/call.js");
  return callGateway<T>(opts);
}

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
}): Promise<AnnounceTarget | null> {
  try {
    const list = await callGatewayLazy<{ sessions: Array<SessionListRow> }>({
      method: "sessions.list",
      params: {
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const match =
      sessions.find((entry) => entry?.key === params.sessionKey) ??
      sessions.find((entry) => entry?.key === params.displayKey);

    const context = normalizeDeliveryContext(match?.deliveryContext);
    if (context?.channel && context.to) {
      const threadId = normalizeOptionalStringifiedId(context.threadId);
      return { channel: context.channel, to: context.to, accountId: context.accountId, threadId };
    }
  } catch {
    // ignore
  }

  return null;
}
