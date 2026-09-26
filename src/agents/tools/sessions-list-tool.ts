/**
 * sessions_list built-in tool.
 *
 * Lists visible sessions and optionally hydrates titles, last messages, and transcript-derived metadata.
 */
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import pMap from "p-map";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { SessionsListParamsSchema } from "../../../packages/gateway-protocol/src/schema/sessions-list.js";
import {
  SessionRunStatusSchema,
  type SessionRunStatus,
} from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { deriveSessionTitle, prepareSessionTitleRead } from "../../gateway/session-utils-core.js";
import { classifySessionKeyShape, isIncognitoSessionKey } from "../../routing/session-key.js";
import { getSessionStateVersions } from "../../sessions/session-state-events.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import {
  describeSessionLinkRule,
  describeSessionsListTool,
  describeSessionVisibilityScope,
  SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { stripToolMessages } from "./chat-history-text.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
} from "./common.js";
import { captureGatewayToolCallerAssertion } from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  getInProcessGatewayToolContext,
  hasGatewayToolRoutingContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { resolveSessionToolTargetAgentId } from "./scoped-session-access.js";
import {
  createSessionVisibilityRowChecker,
  classifySessionListKind,
  deriveChannel,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveSessionToolContext,
  SESSION_LIST_KINDS,
  SessionListRowSchema,
  type GatewaySessionListRow,
  type SessionListRow,
} from "./sessions-helpers.js";

const SessionsListToolSchema = Type.Object({
  kinds: Type.Optional(Type.Array(stringEnum(SESSION_LIST_KINDS))),
  limit: SessionsListParamsSchema.properties.limit,
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  activeMinutes: SessionsListParamsSchema.properties.activeMinutes,
  activeOnly: SessionsListParamsSchema.properties.activeOnly,
  excludeSubagents: SessionsListParamsSchema.properties.excludeSubagents,
  relationship: Type.Optional(
    stringEnum(["owned", "created", "involving"], {
      description:
        "Relation to the authenticated requesting user; unavailable without a trusted user identity.",
    }),
  ),
  ownerId: SessionsListParamsSchema.properties.ownerId,
  creatorId: SessionsListParamsSchema.properties.creatorId,
  projectId: SessionsListParamsSchema.properties.projectId,
  workspaceDir: SessionsListParamsSchema.properties.workspaceDir,
  group: SessionsListParamsSchema.properties.group,
  pinned: SessionsListParamsSchema.properties.pinned,
  messageLimit: Type.Optional(Type.Integer({ minimum: 0 })),
  label: Type.Optional(Type.String({ minLength: 1 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  search: Type.Optional(Type.String({ minLength: 1 })),
  archived: SessionsListParamsSchema.properties.archived,
  includeDerivedTitles: SessionsListParamsSchema.properties.includeDerivedTitles,
  includeLastMessage: SessionsListParamsSchema.properties.includeLastMessage,
});

const SessionsListOutputSchema = Type.Object(
  {
    count: Type.Number(),
    sessions: Type.Array(SessionListRowSchema),
    hasMore: Type.Boolean(),
    nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
    limitApplied: Type.Integer({ minimum: 1, maximum: 200 }),
    truncationReason: Type.Optional(stringEnum(["scan-limit", "byte-limit"])),
    enrichmentOmitted: Type.Optional(
      Type.Boolean({
        description:
          "Inline messages and transcript previews were omitted to fit the byte budget; read session history separately.",
      }),
    ),
    sessionLinkRule: Type.Optional(
      Type.String({
        description: "How to build Control UI URLs for sessionKey values in this result.",
      }),
    ),
    visibility: Type.Optional(
      Type.Object(
        {
          mode: Type.Union([Type.Literal("self"), Type.Literal("tree"), Type.Literal("agent")]),
          restricted: Type.Literal(true),
          warning: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type GatewayCaller = AgentToolGatewayRequestCaller;

const SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS = 100;
const SESSIONS_LIST_MAX_SCAN_PAGES = 5;
const SESSIONS_LIST_MAX_RESULT_BYTES = 64 * 1024;

function projectInventoryActor(actor: NonNullable<SessionListRow["createdActor"]>) {
  const { type, id, label, identity } = actor;
  return { type, id, label, identity };
}

function readSessionRunStatus(value: unknown): SessionRunStatus | undefined {
  return Value.Check(SessionRunStatusSchema, value) ? value : undefined;
}

/** Creates the sessions-list tool with Gateway-owned listing and bounded enrichment. */
export function createSessionsListTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  sessionLinkBase?: string;
  requesterProfileId?: string;
  supportsActiveOnly?: boolean;
  requireSessionReadOwner?: boolean;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_list",
    displaySummary: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsListTool({ sessionLinkBase: opts?.sessionLinkBase }),
    parameters:
      opts?.supportsActiveOnly === false
        ? Type.Omit(SessionsListToolSchema, ["activeOnly"])
        : SessionsListToolSchema,
    outputSchema: SessionsListOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const assertCallerCurrent = captureGatewayToolCallerAssertion();
      const gatewayContext = getInProcessGatewayToolContext();
      const params = args as Record<string, unknown>;
      if (params.activeOnly === true && opts?.supportsActiveOnly === false) {
        throw new Error("activeOnly requires a Gateway-backed inventory with live run state");
      }
      const {
        cfg,
        mainKey,
        alias,
        effectiveRequesterKey,
        mainSessionKey,
        restrictToSpawned,
        sessionVisibility: visibility,
        a2aPolicy,
      } = resolveSessionToolContext(opts);
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: effectiveRequesterKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;
      const kindsRaw = readStringArrayParam(params, "kinds")?.map((value) => value.toLowerCase());
      const requestedKinds = params.kinds;
      const allowedKinds =
        (Array.isArray(requestedKinds) || typeof requestedKinds === "string") &&
        requestedKinds.length > 0
          ? new Set(kindsRaw)
          : undefined;

      const limit = readPositiveIntegerParam(params, "limit");
      const initialOffset = readNonNegativeIntegerParam(params, "offset") ?? 0;
      const activeMinutes = readPositiveIntegerParam(params, "activeMinutes");
      const messageLimitRaw = readNonNegativeIntegerParam(params, "messageLimit") ?? 0;
      const messageLimit = Math.min(messageLimitRaw, 20);
      const label = readToolStringParam(params, "label");
      const agentId = readToolStringParam(params, "agentId");
      const search = readToolStringParam(params, "search");
      const archived = params.archived === "all" ? "all" : params.archived === true;
      const relationship = readToolStringParam(params, "relationship", {
        required: params.relationship !== undefined,
      });
      if (relationship && !["owned", "created", "involving"].includes(relationship)) {
        throw new Error("relationship must be owned, created, or involving");
      }
      const profileId = opts?.requesterProfileId?.trim();
      if (relationship && !profileId) {
        throw new Error(
          "relationship requires an authenticated requesting user; use an explicit ownerId or creatorId instead",
        );
      }
      const ownerId = readToolStringParam(params, "ownerId", {
        required: params.ownerId !== undefined,
      });
      const creatorId = readToolStringParam(params, "creatorId", {
        required: params.creatorId !== undefined,
      });
      const projectId = readToolStringParam(params, "projectId", {
        required: params.projectId !== undefined,
      });
      const workspaceDir = readToolStringParam(params, "workspaceDir", {
        required: params.workspaceDir !== undefined,
      });
      const includeDerivedTitles = params.includeDerivedTitles === true;
      const includeLastMessage = params.includeLastMessage === true;
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const requireSessionReadOwner =
        opts?.requireSessionReadOwner === true ||
        Boolean(gatewayContext) ||
        hasGatewayToolRoutingContext();
      const hydrateTranscriptFieldsAfterFiltering = includeDerivedTitles || includeLastMessage;
      const defaultAgentId = requesterAgentId;
      const visibilityGuard = createSessionVisibilityRowChecker({
        action: "list",
        defaultAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility,
        a2aPolicy,
      });
      const visibleReference = (key: string, parentSessionKey?: string) => {
        if (isIncognitoSessionKey(key)) {
          return undefined;
        }
        try {
          const referenceAgentId = resolveSessionToolTargetAgentId({
            cfg,
            targetSessionKey: key,
            requesterAgentId,
          });
          if (
            !visibilityGuard.check({ key, agentId: referenceAgentId, parentSessionKey }).allowed
          ) {
            return undefined;
          }
          return resolveDisplaySessionKey({ key, alias, mainKey });
        } catch {
          return undefined;
        }
      };
      const sessions: Array<{ entry: GatewaySessionListRow; agentId: string; offset: number }> = [];
      const seenSessions = new Set<string>();
      const outputLimit = Math.min(limit ?? 100, 200);
      let offset = initialOffset;
      let nextOffset: number | undefined;
      let hasMore = false;
      let truncationReason: "scan-limit" | "byte-limit" | undefined;
      for (let pageIndex = 0; sessions.length < outputLimit; pageIndex += 1) {
        const page = await gatewayCall<{
          sessions?: GatewaySessionListRow[];
          hasMore?: boolean;
          nextOffset?: number | null;
        }>({
          method: "sessions.list",
          ...(signal ? { signal } : {}),
          params: {
            limit: 200,
            offset,
            activeMinutes,
            label,
            agentId,
            search,
            archived,
            activeOnly: params.activeOnly === true,
            excludeSubagents: params.excludeSubagents === true,
            ownerId,
            creatorId,
            profileRelation: relationship && profileId ? { profileId, relationship } : undefined,
            projectId,
            workspaceDir,
            group: typeof params.group === "string" ? params.group : undefined,
            pinned: typeof params.pinned === "boolean" ? params.pinned : undefined,
            includeDerivedTitles: false,
            includeLastMessage: false,
            includeGlobal: !restrictToSpawned,
            includeUnknown: !restrictToSpawned,
            spawnedBy: restrictToSpawned ? effectiveRequesterKey : undefined,
          },
        });
        const pageSessions = Array.isArray(page?.sessions) ? page.sessions : [];
        if (pageSessions.length > 200) {
          throw new Error("sessions.list returned more than the requested 200-row page");
        }
        const pageNextOffset = page?.hasMore === true ? offset + pageSessions.length : undefined;
        if (
          pageNextOffset !== undefined &&
          (pageSessions.length === 0 ||
            !Number.isSafeInteger(page.nextOffset) ||
            page.nextOffset !== pageNextOffset)
        ) {
          throw new Error(
            `sessions.list returned invalid pagination metadata (offset=${offset}, nextOffset=${String(page.nextOffset)})`,
          );
        }
        for (let index = 0; index < pageSessions.length; index += 1) {
          const entry = pageSessions[index]!;
          const key =
            entry && typeof entry === "object" && typeof entry.key === "string" ? entry.key : "";
          if (!key) {
            continue;
          }
          // Cross-session tool output is copied into durable transcripts, so exposing
          // incognito rows here would defeat their process-only lifetime.
          if (isIncognitoSessionKey(key)) {
            continue;
          }
          if (classifySessionKeyShape(key) === "malformed_agent") {
            // A malformed scoped key is not an unscoped fixed-store row. Treating
            // it as bare would let the compatibility owner adopt invalid input.
            continue;
          }
          let resolvedAgentId: string;
          try {
            resolvedAgentId = resolveSessionToolTargetAgentId({
              cfg,
              targetSessionKey: key,
              resolvedAgentId:
                typeof entry.agentId === "string" && entry.agentId ? entry.agentId : undefined,
              requesterAgentId,
            });
          } catch {
            // An unowned fixed-store row is unavailable rather than adopted by the requester.
            continue;
          }
          // Sentinel keys repeat across agent stores; incarnation IDs distinguish replacements.
          const identity = JSON.stringify([resolvedAgentId, key, readStringValue(entry.sessionId)]);
          if (seenSessions.has(identity)) {
            continue;
          }
          seenSessions.add(identity);
          const access = visibilityGuard.check({
            key,
            agentId: resolvedAgentId,
            ownerSessionKey:
              typeof (entry as { ownerSessionKey?: unknown }).ownerSessionKey === "string"
                ? (entry as { ownerSessionKey?: string }).ownerSessionKey
                : undefined,
            spawnedBy: typeof entry.spawnedBy === "string" ? entry.spawnedBy : undefined,
            parentSessionKey:
              typeof entry.parentSessionKey === "string" ? entry.parentSessionKey : undefined,
          });
          const kind = classifySessionListKind(entry);
          if (
            access.allowed &&
            key !== "unknown" &&
            (key !== "global" || alias === "global") &&
            (!allowedKinds || allowedKinds.has(kind))
          ) {
            sessions.push({ entry, agentId: resolvedAgentId, offset: offset + index });
            if (sessions.length === outputLimit) {
              hasMore = index + 1 < pageSessions.length || page?.hasMore === true;
              nextOffset = hasMore ? offset + index + 1 : undefined;
              break;
            }
          }
        }
        if (sessions.length === outputLimit) {
          break;
        }
        if (pageNextOffset === undefined) {
          hasMore = false;
          nextOffset = undefined;
          break;
        }
        hasMore = true;
        nextOffset = pageNextOffset;
        // Continue in a later tool call instead of throwing away a sparse partial page.
        if (pageIndex + 1 >= SESSIONS_LIST_MAX_SCAN_PAGES) {
          truncationReason = "scan-limit";
          break;
        }
        offset = pageNextOffset;
      }

      const stateVersions = getSessionStateVersions(
        sessions.map(({ entry, agentId: stateAgentId }) => ({
          sessionKey: entry.key,
          agentId: stateAgentId,
        })),
      );
      const rows: SessionListRow[] = [];
      const historyTargets: Array<{ row: SessionListRow; resolvedKey: string }> = [];
      const titleTargets: Array<{
        source: GatewaySessionListRow;
        row: SessionListRow;
        titleEntry: SessionEntry;
        sessionId: string;
        sessionKey: string;
        agentId: string;
      }> = [];

      for (const { entry, agentId: resolvedAgentId } of sessions) {
        const key = entry.key;
        const kind = classifySessionListKind(entry);
        const displayKey = resolveDisplaySessionKey({
          key,
          alias,
          mainKey,
        });

        const entryChannel = readStringValue(entry.channel);
        const entryOrigin = entry.origin as Record<string, unknown> | undefined;
        const originChannel =
          typeof entryOrigin?.provider === "string" ? entryOrigin.provider : undefined;
        const deliveryContext = entry.deliveryContext;
        const deliveryChannel = readStringValue(deliveryContext?.channel);
        const lastChannel = deliveryChannel ?? readStringValue(entry.lastChannel);
        const derivedChannel = deriveChannel({
          key,
          kind,
          channel: entryChannel ?? originChannel,
          lastChannel,
        });

        const sessionId = readStringValue(entry.sessionId);
        // Sentinel keys alone carry no agent identity; use the prepared store owner.
        const stateVersion = stateVersions[resolvedAgentId]?.[key];
        const rowLabel = readStringValue(entry.label);
        const color = readStringValue(entry.color);
        // Gateway rows carry groups under the legacy wire field `category`.
        const group = readStringValue(entry.category);
        const displayName = readStringValue(entry.displayName);
        const derivedTitle = readStringValue(entry.derivedTitle);
        const lastMessagePreview = readStringValue(entry.lastMessagePreview);
        const parentSessionKeyRaw =
          typeof entry.parentSessionKey === "string"
            ? entry.parentSessionKey
            : typeof entry.spawnedBy === "string"
              ? entry.spawnedBy
              : undefined;
        const parentSessionKey = parentSessionKeyRaw
          ? visibleReference(parentSessionKeyRaw)
          : undefined;
        const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : undefined;
        const model = readStringValue(entry.model);
        // sessions.list owns runtime/context provenance; this tool only filters and
        // narrows its GatewaySessionListRow without reinterpreting raw session state.
        const contextTokens =
          typeof entry.contextTokens === "number" ? entry.contextTokens : undefined;
        const totalTokens = typeof entry.totalTokens === "number" ? entry.totalTokens : undefined;
        const status = readSessionRunStatus(entry.status);
        const abortedLastRun =
          typeof entry.abortedLastRun === "boolean" ? entry.abortedLastRun : undefined;
        const childSessions = Array.isArray(entry.childSessions)
          ? entry.childSessions.flatMap((value) => {
              const visible = typeof value === "string" ? visibleReference(value, key) : undefined;
              return visible ? [visible] : [];
            })
          : undefined;
        const row: SessionListRow = {
          key: displayKey,
          ...(sessionId ? { sessionId } : {}),
          agentId: resolvedAgentId,
          kind,
          channel: derivedChannel,
          archived: entry.archived === true,
          pinned: entry.pinned === true,
          ...(rowLabel ? { label: rowLabel } : {}),
          ...(color ? { color } : {}),
          ...(entry.createdActor
            ? { createdActor: projectInventoryActor(entry.createdActor) }
            : {}),
          ...(entry.owner ? { owner: { actor: projectInventoryActor(entry.owner.actor) } } : {}),
          ...(entry.worktree
            ? {
                worktree: {
                  id: entry.worktree.id,
                  branch: entry.worktree.branch,
                  repoRoot: entry.worktree.repoRoot,
                },
              }
            : {}),
          ...(entry.repositoryWorkspaceId
            ? { repositoryWorkspaceId: entry.repositoryWorkspaceId }
            : {}),
          ...(entry.repository
            ? {
                repository: {
                  url: entry.repository.url,
                  ref: entry.repository.ref,
                  branch: entry.repository.branch,
                },
              }
            : {}),
          ...(entry.execCwd ? { execCwd: entry.execCwd } : {}),
          ...(entry.spawnedCwd ? { spawnedCwd: entry.spawnedCwd } : {}),
          ...(entry.spawnedWorkspaceDir ? { spawnedWorkspaceDir: entry.spawnedWorkspaceDir } : {}),
          ...(entry.projectId ? { projectId: entry.projectId } : {}),
          ...(entry.workspaceDir ? { workspaceDir: entry.workspaceDir } : {}),
          ...(group ? { group } : {}),
          ...(displayName ? { displayName } : {}),
          ...(derivedTitle ? { derivedTitle } : {}),
          ...(lastMessagePreview ? { lastMessagePreview } : {}),
          ...(parentSessionKey ? { parentSessionKey } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          ...(stateVersion ? { stateVersion } : {}),
          ...(model ? { model } : {}),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(status ? { status } : {}),
          ...(abortedLastRun !== undefined ? { abortedLastRun } : {}),
          ...(childSessions ? { childSessions } : {}),
        };
        if (
          sessionId &&
          hydrateTranscriptFieldsAfterFiltering &&
          titleTargets.length < SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS
        ) {
          titleTargets.push({
            source: entry,
            row,
            titleEntry: {
              sessionId,
              displayName: row.displayName,
              label: row.label,
              subject: readStringValue((entry as { subject?: unknown }).subject),
              updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
            },
            sessionId,
            sessionKey: resolveInternalSessionKey({
              key,
              alias,
              mainKey,
            }),
            agentId: resolvedAgentId,
          });
        }
        if (messageLimit > 0) {
          const resolvedKey = resolveInternalSessionKey({
            key,
            alias,
            mainKey,
          });
          historyTargets.push({ row, resolvedKey });
        }
        rows.push(row);
      }

      const unavailableRows = new Set<SessionListRow>();
      await pMap(
        titleTargets,
        async (target) => {
          // Named titles still consume the first-100 budget without rereading a transcript.
          const titleRead = prepareSessionTitleRead(target.titleEntry, undefined, {
            includeDerivedTitles: includeDerivedTitles && !target.row.derivedTitle,
            includeLastMessage,
          });
          if (!titleRead) {
            return;
          }
          const fields = titleRead.needsTranscript
            ? await (
                await import("../../gateway/session-list-read-result.js")
              ).readSessionListRowTitleFields(target.source, requireSessionReadOwner)
            : undefined;
          if (fields === null) {
            unavailableRows.add(target.row);
            return;
          }
          const described =
            titleRead.needsTranscript && fields === undefined
              ? await gatewayCall<{ session: GatewaySessionListRow | null }>({
                  method: "sessions.describe",
                  ...(signal ? { signal } : {}),
                  params: {
                    key: target.sessionKey,
                    agentId: target.agentId,
                    includeDerivedTitles,
                    includeLastMessage,
                  },
                })
              : undefined;
          if (described && described.session?.sessionId !== target.sessionId) {
            unavailableRows.add(target.row);
            return;
          }
          if (includeDerivedTitles && !target.row.derivedTitle) {
            target.row.derivedTitle =
              titleRead.derivedTitle ??
              readStringValue(described?.session?.derivedTitle) ??
              deriveSessionTitle(target.titleEntry, fields?.firstUserMessage);
          }
          const preview =
            fields?.lastMessagePreview ?? readStringValue(described?.session?.lastMessagePreview);
          if (includeLastMessage && preview) {
            target.row.lastMessagePreview = preview;
          }
        },
        { concurrency: 4, stopOnError: true },
      );

      if (messageLimit > 0 && historyTargets.length > 0) {
        await pMap(
          historyTargets.filter((target) => !unavailableRows.has(target.row)),
          async (target) => {
            const history = await gatewayCall<{ messages: Array<unknown> }>({
              method: "chat.history",
              ...(signal ? { signal } : {}),
              params: {
                sessionKey: target.resolvedKey,
                agentId: target.row.agentId,
                limit: messageLimit,
              },
            });
            const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
            const filtered = stripToolMessages(rawMessages);
            target.row.messages =
              filtered.length > messageLimit ? filtered.slice(-messageLimit) : filtered;
          },
          { concurrency: 4, stopOnError: true },
        );
      }

      const visibilityMetadata =
        visibility === "all"
          ? undefined
          : {
              mode: visibility,
              restricted: true,
              warning: `Session visibility is restricted (effective tools.sessions.visibility=${visibility}: ${describeSessionVisibilityScope(visibility, { spawnRestricted: restrictToSpawned })}). Sessions outside that scope are omitted from results and count.`,
            };

      const finalize = (visible: readonly boolean[]) => {
        signal?.throwIfAborted();
        assertCallerCurrent?.("sessions.list");
        if (gatewayContext && getInProcessGatewayToolContext() !== gatewayContext) {
          throw new Error("Gateway instance unavailable for sessions.list");
        }
        const retained = rows.flatMap((row, index) =>
          unavailableRows.has(row) || !visible[index]
            ? []
            : [{ row, offset: sessions[index]!.offset }],
        );
        const retainedRows = retained.map(({ row }) => row);
        let enrichmentOmitted = false;
        const resultFor = (count: number) => ({
          count,
          sessions: retainedRows.slice(0, count),
          hasMore: count < retainedRows.length || hasMore,
          ...(count < retainedRows.length
            ? { nextOffset: retained[count]?.offset }
            : nextOffset !== undefined
              ? { nextOffset }
              : {}),
          limitApplied: outputLimit,
          ...(enrichmentOmitted ? { enrichmentOmitted: true } : {}),
          ...(count < retainedRows.length
            ? { truncationReason: "byte-limit" as const }
            : truncationReason
              ? { truncationReason }
              : {}),
          ...(opts?.sessionLinkBase
            ? { sessionLinkRule: describeSessionLinkRule(opts.sessionLinkBase) }
            : {}),
          ...(visibilityMetadata ? { visibility: visibilityMetadata } : {}),
        });
        const fits = (count: number) =>
          Buffer.byteLength(JSON.stringify(resultFor(count), null, 2), "utf8") <=
          SESSIONS_LIST_MAX_RESULT_BYTES;
        // A large optional preview must not make an otherwise usable inventory fail.
        // Keep identity/metadata intact and report the enrichment downgrade explicitly.
        if (retainedRows.length > 0 && !fits(1)) {
          for (const row of retainedRows) {
            enrichmentOmitted ||=
              row.messages !== undefined ||
              row.derivedTitle !== undefined ||
              row.lastMessagePreview !== undefined;
            delete row.messages;
            delete row.derivedTitle;
            delete row.lastMessagePreview;
          }
        }
        let count = retainedRows.length;
        if (!fits(count)) {
          let lower = 0;
          let upper = count;
          while (lower < upper) {
            const middle = Math.ceil((lower + upper) / 2);
            if (fits(middle)) {
              lower = middle;
            } else {
              upper = middle - 1;
            }
          }
          count = lower;
          if (count === 0) {
            throw new Error(
              "Session metadata exceeds the 64 KiB result budget even without previews; use a narrower inventory query",
            );
          }
        }
        return jsonResult(resultFor(count));
      };
      if (
        !requireSessionReadOwner &&
        !hydrateTranscriptFieldsAfterFiltering &&
        messageLimit === 0
      ) {
        return finalize(rows.map(() => true));
      }
      const { withCurrentSessionListRows } =
        await import("../../gateway/session-list-read-result.js");
      return await withCurrentSessionListRows(
        sessions.map(({ entry }) => entry),
        finalize,
        requireSessionReadOwner,
      );
    },
  };
}
