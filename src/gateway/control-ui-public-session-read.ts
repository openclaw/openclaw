import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { PublicSessionShareLocator } from "./control-ui-public-session-token.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

type PublicSessionShareReadResult = {
  messages: unknown[];
  title: string;
  totalMessages: number;
  truncated: boolean;
  olderOffset?: number;
};

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
  options: { offset?: number; projection: SessionRowProjection },
): Promise<PublicSessionShareReadResult | null> {
  const { projection } = options;
  if (isIncognitoSessionKey(locator.sessionKey) || !listAgentIds(cfg).includes(locator.agentId)) {
    return null;
  }
  await withReadySessionRows(
    projection,
    () => [{ key: locator.sessionKey, agentId: locator.agentId }],
    () => undefined,
  );
  const initial = readAuthorizedTarget(cfg, locator, projection);
  if (!initial) {
    return null;
  }
  const history = await readSessionMessagesPageWithStatsAsync(
    {
      agentId: initial.source.agentId,
      sessionKey: locator.sessionKey,
      sessionId: locator.sessionId,
      storePath: initial.source.path,
      sessionEntry: initial.target.entry,
    },
    {
      offset: options.offset ?? 0,
      maxMessages: 100,
      maxBytes: 1024 * 1024,
      allowResetArchiveFallback: false,
    },
  );
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
  return {
    title: title || "Shared session",
    messages: history.messages,
    totalMessages: history.totalMessages,
    truncated: history.omittedOversized === true,
    ...(history.olderOffset !== undefined ? { olderOffset: history.olderOffset } : {}),
  };
}
