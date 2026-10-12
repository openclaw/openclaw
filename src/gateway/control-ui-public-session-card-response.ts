import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import type { PublicSessionCardRenderer } from "./control-ui-public-session-card.js";
import {
  isPublicSessionShareActive,
  readPublicSessionShare,
} from "./control-ui-public-session-read.js";
import { publicMessageText, publicSessionTitle } from "./control-ui-public-session-render.js";
import type { PublicSessionShareLocator } from "./control-ui-public-session-token.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** Uses the document's admission/cache owner; PNG bytes are cached as base64 text. */
export async function servePublicSessionCardRepresentation(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: OpenClawConfig;
  gate: ControlUiPublicSessionRequestGate;
  locator: PublicSessionShareLocator;
  projection: SessionRowProjection;
  host: string;
  token: string;
  card: {
    render: PublicSessionCardRenderer["render"];
    fallback: () => Promise<void>;
    pullRequests?: GatewayRequestContext["controlUiSessionPullRequests"];
  };
}): Promise<true> {
  const { res, config, gate, locator, projection, card } = params;
  const result = await gate.run({
    publicationKey: locator.shareId,
    sessionKey: locator.sessionKey,
    config,
    requestKey: JSON.stringify([
      "card",
      createHash("sha256").update(params.token).digest("base64url"),
      params.host,
    ]),
    work: async () => {
      const session = await readPublicSessionShare(config, locator, {
        projection,
        card: true,
        pullRequests: card.pullRequests,
      });
      if (!session) {
        return null;
      }
      const quote = session.messages
        .map(publicMessageText)
        .find((message) => message?.role === "user")?.text;
      const png = await card.render({
        ...session.cardFacts,
        title: publicSessionTitle(session.title),
        quote,
        messageCount: session.totalMessages,
        host: params.host,
      });
      return png.toString("base64");
    },
  });
  if (result.kind !== "ok") {
    await card.fallback();
    return true;
  }
  const served = await withReadySessionRows(
    projection,
    () => [{ key: locator.sessionKey, agentId: locator.agentId }],
    () => {
      const representation = result.value;
      if (
        !representation ||
        !representation.isCurrent() ||
        !isPublicSessionShareActive(config, locator, projection)
      ) {
        return false;
      }
      const body = Buffer.from(representation.body, "base64");
      res.statusCode = 200;
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", body.byteLength);
      res.end(body);
      return true as const;
    },
  );
  if (!served) {
    await card.fallback();
  }
  return true;
}
