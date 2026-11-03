import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import { truncateOptionalText } from "../../shared/text-truncate.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { respondError } from "./response.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type SessionPreviewSource = {
  sessionKey: string;
  title?: string;
  derivedTitle?: string;
  agentId: string;
  kind?: string;
  channel?: string;
  updatedAt?: number | null;
  lastMessagePreview?: string;
  archived?: boolean;
};

const SESSION_PREVIEW_TEXT_MAX_CHARS = 200;

function parseSessionPreviewKey(params: unknown): string | null {
  if (!isRecord(params) || Object.keys(params).some((key) => key !== "sessionKey")) {
    return null;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  return sessionKey && sessionKey.length <= 512 ? sessionKey : null;
}

function projectSessionPreview(source: SessionPreviewSource | null): ControlUiSessionPreview {
  if (!source) {
    return { status: "unavailable" };
  }
  const lastMessagePreview = truncateOptionalText(
    source.lastMessagePreview,
    SESSION_PREVIEW_TEXT_MAX_CHARS,
  );
  const title = truncateOptionalText(source.title, SESSION_PREVIEW_TEXT_MAX_CHARS);
  const derivedTitle = truncateOptionalText(source.derivedTitle, SESSION_PREVIEW_TEXT_MAX_CHARS);
  const kind = truncateOptionalText(source.kind, 64);
  const channel = truncateOptionalText(source.channel, 80);
  return {
    status: "ok",
    sessionKey: source.sessionKey,
    agentId: source.agentId,
    ...(title ? { title } : {}),
    ...(derivedTitle ? { derivedTitle } : {}),
    ...(kind ? { kind } : {}),
    ...(channel ? { channel } : {}),
    ...(typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
      ? { updatedAt: source.updatedAt }
      : {}),
    ...(lastMessagePreview ? { lastMessagePreview } : {}),
    ...(typeof source.archived === "boolean" ? { archived: source.archived } : {}),
  };
}

async function withControlUiSessionPreview(
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
  consume: (preview: SessionPreviewSource | null) => void,
): Promise<void> {
  const projection = getSessionRowProjection(context);
  if (!projection) {
    consume(null);
    return;
  }
  const previewConfig = context.getRuntimeConfig();
  const previewOwner = resolveRequestedGlobalAgentId(previewConfig, sessionKey);
  const preview = previewOwner.ok
    ? projection.readPreview({ key: sessionKey, agentId: previewOwner.agentId })
    : null;
  if (
    preview !== undefined &&
    !(
      operatorSessionCap(client, previewConfig) === "invited" &&
      projection.needsMembershipPreparation()
    )
  ) {
    const entryFilter = createSessionListEntryFilter({
      client,
      cfg: previewConfig,
      membership: previewOwner.ok
        ? projection.readMembership({ key: sessionKey, agentId: previewOwner.agentId })
        : undefined,
    });
    consume(
      preview && (!entryFilter || entryFilter(preview.sessionKey, preview.entry)) ? preview : null,
    );
    return;
  }
  await withReadySessionRows(
    projection,
    (cfg) => {
      const owner = resolveRequestedGlobalAgentId(cfg, sessionKey);
      return owner.ok ? [{ key: sessionKey, agentId: owner.agentId }] : [];
    },
    (read) => {
      const cfg = context.getRuntimeConfig();
      const owner = resolveRequestedGlobalAgentId(cfg, sessionKey);
      const record = owner.ok
        ? read.describe({ key: sessionKey, agentId: owner.agentId })
        : undefined;
      // Hover previews follow list visibility, including after asynchronous preparation.
      const entryFilter = createSessionListEntryFilter({
        client,
        cfg,
        membership: record?.membership,
      });
      if (!record || (entryFilter && !entryFilter(record.key, record.entry))) {
        consume(null);
        return;
      }
      const row = read.present(record, { includeDerivedTitles: true, includeLastMessage: true });
      consume({
        sessionKey: row.key,
        agentId: record.agentId,
        title: row.displayName,
        derivedTitle: row.derivedTitle,
        kind: row.kind,
        channel: row.channel,
        updatedAt: row.updatedAt,
        lastMessagePreview: row.lastMessagePreview,
        archived: row.archived,
      });
    },
  );
}

export const controlUiHandlers: GatewayRequestHandlers = {
  "controlUi.linkPreview": async ({
    params,
    client,
    context,
    respond,
    signal,
    hasCurrentClientAuthority,
  }) => {
    const revision = () =>
      JSON.stringify([
        getRuntimeConfigSnapshotMetadata()?.revision,
        client?.authenticatedUserId,
        client?.authenticatedUserProfile?.profileId,
      ]);
    const scope = { principal: client ?? context, revision: revision() };
    const isEnabled = () =>
      !client?.connectionSignal?.aborted &&
      hasCurrentClientAuthority?.() !== false &&
      revision() === scope.revision &&
      context.getRuntimeConfig().gateway?.controlUi?.automaticallyFetchFavicons !== false;
    if (signal?.aborted || !isEnabled()) {
      respond(true, {}, undefined);
      return;
    }
    const { parseControlUiLinkPreviewUrl, loadControlUiLinkPreview } =
      await import("../control-ui-link-preview.js");
    const url = Object.keys(params).every((key) => key === "url")
      ? parseControlUiLinkPreviewUrl(params.url)
      : null;
    if (!url) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "invalid controlUi.linkPreview params");
      return;
    }
    const preview = await loadControlUiLinkPreview(url, isEnabled, scope);
    respond(true, !signal?.aborted && isEnabled() ? preview : {}, undefined);
  },
  "controlUi.sessionPreview": async ({
    params,
    client,
    context,
    respond,
    signal,
    hasCurrentClientAuthority,
  }) => {
    const sessionKey = parseSessionPreviewKey(params);
    if (!sessionKey) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "invalid controlUi.sessionPreview params");
      return;
    }
    try {
      while (!getSubagentSessionListReadSnapshotIdentity()) {
        await prepareSubagentSessionListReadCache();
      }
      signal?.throwIfAborted();
      const consume = (preview: SessionPreviewSource | null) => {
        signal?.throwIfAborted();
        if (hasCurrentClientAuthority?.() === false) {
          throw new Error("Session preview request is no longer active");
        }
        respond(true, projectSessionPreview(preview), undefined);
      };
      await withControlUiSessionPreview(sessionKey, context, client, consume);
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Session preview unavailable"));
    }
  },
};
