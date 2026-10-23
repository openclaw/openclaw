import type { IncomingMessage, ServerResponse } from "node:http";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import { buildPublicSessionWidgetUrl } from "./control-ui-public-session-attachments.js";
import { projectPublicSessionItems } from "./control-ui-public-session-project.js";
import {
  isPublicSessionShareActive,
  readPublicSessionShare,
} from "./control-ui-public-session-read.js";
import { renderPublicSessionDocument } from "./control-ui-public-session-render.js";
import {
  mintPublicSessionWidgetToken,
  type PublicSessionShareLocator,
} from "./control-ui-public-session-token.js";
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
    | "latestUrl"
    | "canonicalUrl"
    | "cardUrl"
    | "entryUrl"
    | "clientAuthBasePath"
    | "assetBasePath"
    | "mediaBaseUrl"
  >;
  olderUrl: (offset: number) => string;
  unavailable: (status: 404 | 429 | 503, retryAfterSeconds?: number) => true | Promise<true>;
}): Promise<true> {
  const { req, res, config, gate, locator, projection, offset, unavailable } = params;
  const result = await gate.run({
    kind: "transcript",
    publicationKey: locator.shareId,
    sessionKey: locator.sessionKey,
    config,
    requestKey: params.requestKey,
    work: async () => {
      const session = await readPublicSessionShare(config, locator, { offset, projection });
      if (!session) {
        return null;
      }
      const widgetUrls = new Map<string, string>();
      // Disabled hosting serves no widget documents; omit their frames rather than link 404s.
      const items = isCoreCanvasHostEnabled(config)
        ? projectPublicSessionItems(session.messages)
        : [];
      for (const item of items) {
        if (item.kind !== "message") {
          continue;
        }
        for (const { docId } of item.embeds.filter((embed) => embed.kind === "widget")) {
          const token = await mintPublicSessionWidgetToken(locator, docId);
          if (token) {
            widgetUrls.set(
              docId,
              buildPublicSessionWidgetUrl(params.document.assetBasePath ?? "", token),
            );
          }
        }
      }
      return renderPublicSessionDocument({
        ...session,
        ...params.document,
        widgetUrls,
        isLatest: offset === 0,
        ...(session.olderOffset !== undefined
          ? { olderUrl: params.olderUrl(session.olderOffset) }
          : {}),
      });
    },
  });
  if (result.kind !== "ok") {
    await unavailable(
      result.kind === "rate-limited" ? 429 : 503,
      result.kind === "rate-limited" ? result.retryAfterSeconds : undefined,
    );
    return true;
  }
  const unavailableStatus = await withReadySessionRows(
    projection,
    () => [{ key: locator.sessionKey, agentId: locator.agentId }],
    () => {
      const representation = result.value;
      if (!representation || !isPublicSessionShareActive(config, locator, projection)) {
        return 404 as const;
      }
      if (!representation.isCurrent()) {
        return 503 as const;
      }
      const { body, etag } = representation;
      if (typeof body !== "string") {
        return 503 as const;
      }
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
      return undefined;
    },
  );
  if (unavailableStatus !== undefined) {
    await unavailable(unavailableStatus);
  }
  return true;
}
