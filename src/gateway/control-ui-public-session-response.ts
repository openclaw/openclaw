import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import {
  isPublicSessionShareActive,
  readPublicSessionShare,
} from "./control-ui-public-session-read.js";
import { renderPublicSessionDocument } from "./control-ui-public-session-render.js";
import type { PublicSessionShareLocator } from "./control-ui-public-session-token.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** Both public routes recheck publication in the synchronous response frame, including 304s. */
export async function servePublicSessionRepresentation(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: OpenClawConfig;
  gate: ControlUiPublicSessionRequestGate;
  locator: PublicSessionShareLocator;
  projection: SessionRowProjection;
  offset: number;
  requestKey: string;
  document: Pick<
    Parameters<typeof renderPublicSessionDocument>[0],
    "latestUrl" | "canonicalUrl" | "cardUrl" | "entryUrl" | "clientAuthBasePath" | "assetBasePath"
  >;
  olderUrl: (offset: number) => string;
  unavailable: (status: 404 | 429 | 503, retryAfterSeconds?: number) => true | Promise<true>;
}): Promise<true> {
  const { req, res, config, gate, locator, projection, offset, unavailable } = params;
  const result = await gate.run({
    publicationKey: locator.shareId,
    sessionKey: locator.sessionKey,
    config,
    requestKey: params.requestKey,
    work: async () => {
      const session = await readPublicSessionShare(config, locator, { offset, projection });
      return session
        ? renderPublicSessionDocument({
            ...session,
            ...params.document,
            isLatest: offset === 0,
            ...(session.olderOffset !== undefined
              ? { olderUrl: params.olderUrl(session.olderOffset) }
              : {}),
          })
        : null;
    },
  });
  if (result.kind !== "ok") {
    await unavailable(
      result.kind === "rate-limited" ? 429 : 503,
      result.kind === "rate-limited" ? result.retryAfterSeconds : undefined,
    );
    return true;
  }
  return withReadySessionRows(
    projection,
    () => [{ key: locator.sessionKey, agentId: locator.agentId }],
    async () => {
      const representation = result.value;
      if (!representation || !isPublicSessionShareActive(config, locator, projection)) {
        await unavailable(404);
      } else if (!representation.isCurrent()) {
        await unavailable(503);
      } else {
        const { body, etag } = representation;
        res.setHeader("ETag", etag);
        if (req.headers["if-none-match"] === etag) {
          res.statusCode = 304;
          res.end();
        } else {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Content-Length", Buffer.byteLength(body));
          res.end(body);
        }
      }
      return true as const;
    },
  );
}
