import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { PublicSessionCardFacts } from "./control-ui-public-session-card-facts.js";
import { publicMessageText } from "./control-ui-public-session-render.js";
import type { PublicSessionShareLocator } from "./control-ui-public-session-token.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

type PublicSessionShareReadResult = {
  messages: unknown[];
  title: string;
  totalMessages: number;
  truncated: boolean;
  olderOffset?: number;
  cardFacts?: PublicSessionCardFacts;
};

const PUBLIC_SESSION_MAX_BYTES = 1024 * 1024;
const PUBLIC_SESSION_MAX_MESSAGES = 100;

async function readPublicSessionOpening(
  scope: Parameters<typeof readSessionMessagesPageWithStatsAsync>[0],
) {
  let remainingBytes = PUBLIC_SESSION_MAX_BYTES;
  let history = await readSessionMessagesPageWithStatsAsync(scope, {
    offset: 0,
    beforeSeq: 2,
    maxMessages: 1,
    maxBytes: remainingBytes,
    allowResetArchiveFallback: false,
  });
  let omittedOversized = history.omittedOversized;
  for (let position = 0; position < PUBLIC_SESSION_MAX_MESSAGES; position++) {
    if (position > 0) {
      history = await readSessionMessagesPageWithStatsAsync(scope, {
        offset: 0,
        beforeSeq: position + 2,
        maxMessages: 1,
        maxBytes: remainingBytes,
        allowResetArchiveFallback: false,
      });
      omittedOversized ||= history.omittedOversized;
    }
    const message = history.messages[0];
    if (publicMessageText(message)?.role === "user") {
      return { ...history, messages: [message], olderOffset: undefined, omittedOversized };
    }
    if (message !== undefined) {
      remainingBytes -= Buffer.byteLength(JSON.stringify(message));
    }
    if (position + 1 >= history.totalMessages || remainingBytes < 1024) {
      break;
    }
  }
  return { ...history, messages: [], olderOffset: undefined, omittedOversized };
}

function readAuthorizedTarget(
  cfg: OpenClawConfig,
  locator: PublicSessionShareLocator,
  projection: SessionRowProjection,
) {
  const parsed = parseAgentSessionKey(locator.sessionKey);
  const fixedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, locator.sessionKey);
  if (
    (locator.sessionKey !== "global" &&
      (!parsed ||
        parsed.agentId !== locator.agentId ||
        locator.sessionKey !== `agent:${parsed.agentId}:${parsed.rest}`)) ||
    fixedOwner.kind === "retired" ||
    (fixedOwner.kind === "configured" && fixedOwner.agentId !== locator.agentId) ||
    !listAgentIds(cfg).includes(locator.agentId) ||
    isIncognitoSessionKey(locator.sessionKey) ||
    projection.sharingRevision === undefined ||
    projection.state.cfg !== cfg
  ) {
    return undefined;
  }
  const query = { key: locator.sessionKey, agentId: locator.agentId };
  const state = projection.sharingTargetState(query);
  if (state.status !== "ready") {
    return undefined;
  }
  const target = state.target;
  const share = resolveSessionPublicShare(target.entry);
  if (
    target.canonicalKey !== locator.sessionKey ||
    target.agentId !== locator.agentId ||
    share?.id !== locator.shareId ||
    share.sessionId !== locator.sessionId
  ) {
    return undefined;
  }
  const source = projection.readSource({ ...query, storePath: target.storePath });
  if (!source || typeof source.databaseIdentity !== "string") {
    return undefined;
  }
  assertExistingDatabaseIdentity(
    source.path,
    `file:${source.databaseIdentity}`,
    source.databaseBirthtime,
  );
  return { target, source };
}

/** The resident owner installs committed sharing facts before a response can consume them. */
export function isPublicSessionShareActive(
  cfg: OpenClawConfig,
  locator: PublicSessionShareLocator,
  projection: SessionRowProjection,
): boolean {
  return Boolean(readAuthorizedTarget(cfg, locator, projection));
}

/** Only the exact published generation is readable; this grants no Gateway session authority. */
export async function readPublicSessionShare(
  cfg: OpenClawConfig,
  locator: PublicSessionShareLocator,
  options: {
    offset?: number;
    projection: SessionRowProjection;
    card?: boolean;
    pullRequests?: GatewayRequestContext["controlUiSessionPullRequests"];
  },
): Promise<PublicSessionShareReadResult | null> {
  const { projection } = options;
  if (isIncognitoSessionKey(locator.sessionKey) || !listAgentIds(cfg).includes(locator.agentId)) {
    return null;
  }
  const queries = () => [{ key: locator.sessionKey, agentId: locator.agentId }];
  const initial = await withReadySessionRows(projection, queries, () =>
    readAuthorizedTarget(cfg, locator, projection),
  );
  if (!initial) {
    return null;
  }
  const scope = {
    agentId: initial.source.agentId,
    sessionKey: locator.sessionKey,
    sessionId: locator.sessionId,
    storePath: initial.source.path,
    sessionEntry: initial.target.entry,
  };
  // Read forward source positions for cards: a newest-first byte bound within
  // the oldest page can otherwise hide the opening behind a later oversized row.
  const history = options.card
    ? await readPublicSessionOpening(scope)
    : await readSessionMessagesPageWithStatsAsync(scope, {
        offset: options.offset ?? 0,
        maxMessages: PUBLIC_SESSION_MAX_MESSAGES,
        maxBytes: PUBLIC_SESSION_MAX_BYTES,
        allowResetArchiveFallback: false,
      });
  const resolveCardFacts = options.card
    ? (await import("./control-ui-public-session-card-facts.js")).resolvePublicSessionCardFacts
    : undefined;
  return withReadySessionRows(projection, queries, (read) => {
    const current = readAuthorizedTarget(cfg, locator, projection);
    if (
      !current ||
      current.source.path !== initial.source.path ||
      current.source.databaseIdentity !== initial.source.databaseIdentity ||
      current.source.databaseBirthtime !== initial.source.databaseBirthtime
    ) {
      return null;
    }
    const title = (
      current.target.entry.label ||
      current.target.entry.displayName ||
      "Shared session"
    ).trim();
    const record = options.card ? read.describe(queries()[0]!) : undefined;
    return {
      title: title || "Shared session",
      messages: history.messages,
      totalMessages: history.totalMessages,
      truncated: history.omittedOversized === true,
      ...(record && resolveCardFacts
        ? {
            cardFacts: resolveCardFacts({
              cfg,
              record,
              rowContext: read.state.rowContext,
              pullRequests: options.pullRequests,
            }),
          }
        : {}),
      ...(history.olderOffset !== undefined ? { olderOffset: history.olderOffset } : {}),
    };
  });
}
