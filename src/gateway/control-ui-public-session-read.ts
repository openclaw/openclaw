import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import { sanitizeChatHistoryContentBlock } from "./chat-display-projection.sanitize.js";
import { projectPublicSessionItems } from "./control-ui-public-session-project.js";
import type { PublicSessionShareLocator } from "./control-ui-public-session-token.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionTranscriptReadScope } from "./session-transcript-read.types.js";
import {
  readSessionMessageByIdAsync,
  readSessionMessagesPageWithStatsAsync,
} from "./session-transcript-readers.js";

const PUBLIC_SESSION_PAGE_ITEMS = 50;
const PUBLIC_SESSION_SCAN_ROWS = 2_000;
const PUBLIC_SESSION_READ_BYTES = 1024 * 1024;
const PUBLIC_SESSION_MEDIA_ENTRY_BYTES =
  Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + PUBLIC_SESSION_READ_BYTES;

type PublicSessionShareReadResult = {
  messages: unknown[];
  title: string;
  totalMessages: number;
  truncated: boolean;
  olderOffset?: number;
};

function compactInlineImagePayloads(message: unknown): unknown {
  const entry = asOptionalRecord(message);
  if (!entry) {
    return undefined;
  }
  const compacted = { ...entry };
  let hasInlineImage = false;
  for (const field of ["content", ASSISTANT_DISPLAY_CONTENT_FIELD]) {
    const content = entry[field];
    if (!Array.isArray(content)) {
      continue;
    }
    compacted[field] = content.map((value) => {
      const block = asOptionalRecord(value);
      const source = asOptionalRecord(block?.source);
      if (
        block?.type !== "image" ||
        ![block.data, block.blob, source?.data, source?.blob].some(
          (data) => typeof data === "string" && data.length > 0,
        )
      ) {
        return value;
      }
      hasInlineImage = true;
      return sanitizeChatHistoryContentBlock(block, { maxChars: Number.MAX_SAFE_INTEGER }).block;
    });
  }
  return hasInlineImage && jsonUtf8Bytes([compacted]) <= PUBLIC_SESSION_READ_BYTES
    ? compacted
    : undefined;
}

async function readVisiblePage(scope: SessionTranscriptReadScope, offset: number) {
  let messages: unknown[] = [];
  let bytes = 2;
  let nextOffset = offset;
  let totalMessages = 0;
  let truncated = false;
  let olderOffset: number | undefined;
  let readWindow: Awaited<ReturnType<typeof readSessionMessagesPageWithStatsAsync>>["readWindow"];
  while (messages.length < PUBLIC_SESSION_SCAN_ROWS && bytes <= PUBLIC_SESSION_READ_BYTES - 1024) {
    const page = await readSessionMessagesPageWithStatsAsync(scope, {
      offset: nextOffset,
      maxMessages: Math.min(100, PUBLIC_SESSION_SCAN_ROWS - messages.length),
      maxBytes: PUBLIC_SESSION_READ_BYTES - bytes,
      allowResetArchiveFallback: false,
      ...(readWindow
        ? { beforeSeq: totalMessages + 1, expectedReadWindow: readWindow }
        : { captureReadWindow: true }),
    });
    if (page.windowReset) {
      return null;
    }
    if (!readWindow) {
      totalMessages = page.totalMessages;
      readWindow = page.readWindow;
    }
    // Retry a row that did not fit the remaining budget with a fresh page budget.
    if (page.omittedOversized && messages.length > 0) {
      olderOffset = nextOffset;
      break;
    }
    if (page.omittedOversized) {
      // A bounded image envelope may exceed the text-page budget. Publish only
      // its compact descriptor; the separately authorized media read retains the bytes.
      const mediaPage = await readSessionMessagesPageWithStatsAsync(scope, {
        offset: nextOffset,
        beforeSeq: totalMessages + 1,
        expectedReadWindow: readWindow,
        maxMessages: 1,
        maxBytes: PUBLIC_SESSION_MEDIA_ENTRY_BYTES,
        allowResetArchiveFallback: false,
      });
      if (mediaPage.windowReset) {
        return null;
      }
      const compacted =
        mediaPage.messages.length === 1
          ? compactInlineImagePayloads(mediaPage.messages[0])
          : undefined;
      if (compacted) {
        messages = [compacted];
        olderOffset = page.olderOffset;
        break;
      }
    }
    messages = [...page.messages, ...messages];
    bytes += jsonUtf8Bytes(page.messages);
    olderOffset = page.olderOffset;
    truncated ||= page.omittedOversized === true;

    const items = projectPublicSessionItems(messages);
    if (items.length > PUBLIC_SESSION_PAGE_ITEMS) {
      // One older item establishes the beginning of the oldest selected tool run.
      const first = items[items.length - PUBLIC_SESSION_PAGE_ITEMS]!;
      const start = first.sourceIndex;
      messages = messages.slice(start);
      olderOffset = offset + messages.length;
      break;
    }
    if (olderOffset === undefined || page.messages.length < 100) {
      break;
    }
    nextOffset = olderOffset;
  }
  truncated ||=
    olderOffset !== undefined &&
    projectPublicSessionItems(messages).length < PUBLIC_SESSION_PAGE_ITEMS;
  return { messages, totalMessages, truncated, olderOffset };
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
  options: { offset?: number; projection: SessionRowProjection },
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
  const history = await readVisiblePage(
    {
      agentId: initial.source.agentId,
      sessionKey: locator.sessionKey,
      sessionId: locator.sessionId,
      storePath: initial.source.path,
      sessionEntry: initial.target.entry,
    },
    options.offset ?? 0,
  );
  if (!history) {
    return null;
  }
  return withReadySessionRows(projection, queries, () => {
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
      truncated: history.truncated,
      ...(history.olderOffset !== undefined ? { olderOffset: history.olderOffset } : {}),
    };
  });
}
/** Media reads share the page's exact publication and physical-store authority. */
export async function readPublicSessionMessage(
  cfg: OpenClawConfig,
  locator: PublicSessionShareLocator,
  options: { entryId: string; projection: SessionRowProjection },
): Promise<Record<string, unknown> | null> {
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
  const selected = await readSessionMessageByIdAsync(
    {
      agentId: initial.source.agentId,
      sessionKey: locator.sessionKey,
      sessionId: locator.sessionId,
      storePath: initial.source.path,
      sessionEntry: initial.target.entry,
    },
    options.entryId,
    {
      currentOnly: true,
      // A permitted image may be inline base64, plus bounded message metadata.
      maxBytes: PUBLIC_SESSION_MEDIA_ENTRY_BYTES,
      allowResetArchiveFallback: false,
    },
  );
  return withReadySessionRows(projection, queries, () => {
    const current = readAuthorizedTarget(cfg, locator, projection);
    return current &&
      current.source.path === initial.source.path &&
      current.source.databaseIdentity === initial.source.databaseIdentity &&
      current.source.databaseBirthtime === initial.source.databaseBirthtime &&
      selected.found &&
      !selected.oversized
      ? (asOptionalRecord(selected.message) ?? null)
      : null;
  });
}
