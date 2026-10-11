import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ErrorShape,
  SessionsResolveCandidate,
  SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  controlUiSessionSlug,
  SESSION_UUID_SUFFIX_RE,
  SHORT_SESSION_ID_RE,
} from "../../packages/session-url-contract/src/index.js";
import { listAgentIds } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { hasOperatorBoundary } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { invalidSessionRequest } from "./session-request-error.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { authorizeIncognitoSessionTarget } from "./session-sharing-policy.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import { resolveGatewaySessionDisplayName } from "./session-utils-display.js";
import { filterAndSortSessionEntries, prepareSessionRowSelection } from "./session-utils-list.js";
import { resolveDeletedAgentIdFromSessionKey } from "./session-utils-store.js";

export type SessionsResolveResult =
  | ({ ok: true } & SessionsResolveCandidate)
  | { ok: true; missing: true }
  | { ok: true; ambiguous: true; candidates: SessionsResolveCandidate[] }
  | { ok: false; error: ErrorShape };

type SessionResolveLookup = Parameters<SessionRowProjection["capture"]>[0];

class SessionResolvePreparationRequired extends Error {
  constructor(readonly queries: SessionResolveLookup[]) {
    super("Session metadata must be prepared before resolution");
  }
}

function resolveSessionVisibilityFilterOptions(p: SessionsResolveParams) {
  return {
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
    agentId: p.agentId,
  };
}

function validateSessionAgentExists(
  cfg: OpenClawConfig,
  key: string,
  acpMeta?: SessionEntry["acp"] | null,
): SessionsResolveResult | null {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key, acpMeta);
  if (deletedAgentId === null) {
    return null;
  }
  return invalidSessionRequest(`Agent "${deletedAgentId}" no longer exists in configuration`);
}

function sessionResolveCandidate(
  key: string,
  entry: SessionEntry,
  agentId: string,
): SessionsResolveCandidate {
  const displayName = resolveGatewaySessionDisplayName(key, entry);
  return {
    key,
    agentId: normalizeAgentId(agentId),
    ...(displayName ? { displayName } : {}),
    ...(entry.boardFace ? { boardFace: entry.boardFace } : {}),
    ...(entry.boardPresentation ? { boardPresentation: entry.boardPresentation } : {}),
  };
}

/** Prepare durable facts, then resolve and consume against current caller state without a yield. */
export async function withPreparedSessionResolve<T>(
  params: Parameters<typeof resolveSessionKeyFromResolveParams>[0] & { isCurrent?: () => boolean },
  consume: (result: SessionsResolveResult) => T,
): Promise<T> {
  const { projection, p } = params;
  const key = normalizeOptionalString(p.key);
  const assertCurrent = () => {
    if (params.isCurrent?.() === false) {
      throw new Error("Session projection changed while resolving the session; retry the request");
    }
  };
  const pending = new Map<string, SessionResolveLookup>();
  const resolve = () => {
    assertCurrent();
    return consume(resolveSessionKeyFromResolveParams(params));
  };
  while (true) {
    try {
      return await withReadySessionRows(
        projection,
        (cfg) => {
          const selected = [...pending.values()];
          if (key) {
            const agent = resolveRequestedSessionAgentId(cfg, key, p.agentId);
            if (agent.ok) {
              selected.push({ key, agentId: agent.agentId });
            }
          }
          return selected;
        },
        resolve,
        // Discovery needs current selection metadata, not every session's display row.
        { selection: !key },
      );
    } catch (error) {
      if (!(error instanceof SessionResolvePreparationRequired)) {
        throw error;
      }
      for (const query of error.queries) {
        pending.set(JSON.stringify([query.agentId, query.key, query.storePath]), query);
      }
    }
  }
}

export function resolveSessionKeyFromResolveParams(params: {
  client: GatewayClient | null;
  projection: SessionRowProjection;
  p: SessionsResolveParams;
  /** Anonymous HTTP audience sees only current publication grants, never operator discovery. */
  publicOnly?: boolean;
}): SessionsResolveResult {
  const { client, p, projection } = params;
  const noSessionFoundResult = (message: string): SessionsResolveResult =>
    p.allowMissing ? { ok: true, missing: true } : invalidSessionRequest(message);
  const { cfg, policyConfig } = projection.state;
  const entryFilter = params.publicOnly
    ? (key: string, entry: SessionEntry) =>
        !isIncognitoSessionKey(key) && Boolean(resolveSessionPublicShare(entry))
    : prepareProjectedSessionPresentation(projection, client).sharing.entryFilter;
  const prepare = (
    agentId = p.agentId,
    configuredAgentsOnly = false,
    selector?: Parameters<typeof prepareSessionRowSelection>[2],
  ) =>
    prepareSessionRowSelection(
      projection,
      {
        ...resolveSessionVisibilityFilterOptions(p),
        agentId,
        configuredAgentsOnly,
      },
      selector,
    );
  const configuredAgentIds = new Set(listAgentIds(cfg));
  const prepareAgentChecks = (
    entries: Array<[string, SessionEntry]>,
    getTarget: ReturnType<typeof prepare>["getTarget"],
  ) => {
    const facts = new Map<SessionEntry, SessionEntry["acp"]>();
    const unresolved: SessionResolveLookup[] = [];
    for (const [candidateKey, entry] of entries) {
      const parsed = parseAgentSessionKey(candidateKey);
      if (
        !parsed ||
        configuredAgentIds.has(parsed.agentId) ||
        !parsed.rest.startsWith("acp:") ||
        parsed.rest.startsWith("acp:binding:")
      ) {
        continue;
      }
      const target = getTarget(candidateKey);
      const current =
        target &&
        projection.capture({
          agentId: target.agentId,
          key: target.key,
          storePath: target.storeTarget.storePath,
        });
      const source = current?.materialized?.source;
      if (source && source.entry === current?.entry) {
        facts.set(entry, source.thinkingProjection.acpMeta);
      } else if (current?.preparedAcpMeta !== undefined) {
        facts.set(entry, current.preparedAcpMeta ?? undefined);
      } else if (current) {
        unresolved.push({
          key: current.key,
          agentId: current.agentId,
          storePath: current.storeTarget.storePath,
        });
      }
    }
    if (unresolved.length) {
      throw new SessionResolvePreparationRequired(unresolved);
    }
    return (candidateKey: string, entry: SessionEntry | undefined) =>
      validateSessionAgentExists(cfg, candidateKey, (entry && facts.get(entry)) ?? null);
  };

  const sessionIdMatches = (agentId?: string) => {
    const prepared = prepare(agentId, false, { sessionIdOrKey: sessionId });
    return {
      matches: filterAndSortSessionEntries({ ...prepared, entryFilter }).filter(
        ([candidateKey, entry]) => entry.sessionId === sessionId || candidateKey === sessionId,
      ),
      getTarget: prepared.getTarget,
    };
  };

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const rawShortId = normalizeOptionalString(p.shortId) ?? "";
  const hasShortId = rawShortId.length > 0;
  const hasReference = p.reference !== undefined;
  const hasSlugHint = p.slugHint !== undefined;
  if (hasSlugHint && !hasShortId) {
    return invalidSessionRequest("slugHint requires shortId");
  }
  const selectionCount = [hasKey, hasSessionId, hasLabel, hasShortId, hasReference].filter(
    Boolean,
  ).length;
  if (selectionCount > 1) {
    return invalidSessionRequest(
      "Provide either key, sessionId, label, shortId, or reference (not multiple)",
    );
  }
  if (selectionCount === 0) {
    return invalidSessionRequest("Either key, sessionId, label, shortId, or reference is required");
  }

  if (p.reference) {
    const referenceKey = normalizeSessionKeyPreservingOpaquePeerIds(p.reference.key);
    const parsed = parseAgentSessionKey(referenceKey);
    const sameAgent = !p.agentId || !parsed || parsed.agentId === normalizeAgentId(p.agentId);
    const exactKey = sameAgent
      ? resolveSessionStoreKey({ cfg, sessionKey: referenceKey, storeAgentId: p.agentId })
      : referenceKey;
    // URL references are discovery, including exact keys. Keep hidden rows out
    // before choosing a winner; the separate key selector retains its read contract.

    const slug = normalizeOptionalString(p.reference.slug);
    const candidates = (lookupKey?: string) => {
      const prepared = prepare(p.agentId, true, { key: lookupKey });
      const visibleEntries = filterAndSortSessionEntries({
        ...prepared,
        entryFilter,
        opts: { ...resolveSessionVisibilityFilterOptions(p), archived: "all" },
      });
      const checkAgent = prepareAgentChecks(visibleEntries, prepared.getTarget);
      return visibleEntries
        .filter(
          ([candidateKey, entry]) =>
            checkAgent(candidateKey, entry) === null &&
            (lookupKey !== undefined
              ? normalizeSessionKeyPreservingOpaquePeerIds(candidateKey) === lookupKey
              : SESSION_UUID_SUFFIX_RE.test(parseAgentSessionKey(candidateKey)?.rest ?? "") &&
                controlUiSessionSlug(resolveGatewaySessionDisplayName(candidateKey, entry)) ===
                  slug),
        )
        .slice(0, lookupKey !== undefined ? 1 : 10)
        .map(([candidateKey, entry]) =>
          sessionResolveCandidate(
            candidateKey,
            entry,
            expectDefined(prepared.getTarget(candidateKey), "reference session agent").agentId,
          ),
        );
    };
    const exact = candidates(exactKey)[0];
    if (exact) {
      return { ok: true, ...exact };
    }
    const matches = slug ? candidates() : [];
    if (matches.length > 1) {
      return { ok: true, ambiguous: true, candidates: matches };
    }
    const selected = matches[0];
    return selected
      ? { ok: true, ...selected }
      : noSessionFoundResult(`No session found: ${p.reference.key}`);
  }

  if (hasKey) {
    // Exact-key lookup follows the proof-of-knowledge read semantics of get/describe/history;
    // only discovery selectors use list visibility. Incognito keys are gated pre-dispatch.
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      return requestedAgent;
    }
    if (authorizeIncognitoSessionTarget({ client, sessionKey: key, target: null })) {
      return noSessionFoundResult(`No session found: ${key}`);
    }
    const target = projection.describe({ agentId: requestedAgent.agentId, key });
    if (target?.entry) {
      const { entry } = target;
      const spawnedBy = typeof p.spawnedBy === "string" && p.spawnedBy.trim().length > 0;
      if (
        ((hasOperatorBoundary(client, policyConfig) || params.publicOnly) &&
          entryFilter?.(target.key, entry) === false) ||
        (spawnedBy &&
          !filterAndSortSessionEntries({ ...prepare(requestedAgent.agentId) }).some(
            ([candidate]) => candidate === target.key,
          ))
      ) {
        return noSessionFoundResult(`No session found: ${key}`);
      }
      return (
        prepareAgentChecks([[target.key, entry]], () => target)(target.key, entry) ?? {
          ok: true,
          key: target.key,
          agentId: requestedAgent.agentId,
        }
      );
    }
    return noSessionFoundResult(`No session found: ${key}`);
  }

  if (hasSessionId) {
    if (!p.agentId) {
      const ownerTaggedMatches = new Map<
        string,
        {
          agentId: string;
          entry: SessionEntry;
          key: string;
          getTarget: ReturnType<typeof prepare>["getTarget"];
        }
      >();
      for (const agentId of listAgentIds(cfg)) {
        const { matches: agentMatches, getTarget } = sessionIdMatches(agentId);
        const agentSelection = resolveSessionIdMatchSelection(agentMatches, sessionId);
        if (agentSelection.kind === "ambiguous") {
          return invalidSessionRequest(
            `Multiple sessions found for sessionId: ${sessionId} (${agentSelection.sessionKeys.join(", ")})`,
          );
        }
        if (agentSelection.kind === "selected") {
          const entry = agentMatches.find(
            ([matchKey]) => matchKey === agentSelection.sessionKey,
          )?.[1];
          const owner = resolveRequestedSessionAgentId(cfg, agentSelection.sessionKey, agentId);
          if (entry && owner.ok) {
            ownerTaggedMatches.set(`${owner.agentId}\0${agentSelection.sessionKey}`, {
              agentId: owner.agentId,
              entry,
              key: agentSelection.sessionKey,
              getTarget,
            });
          }
        }
      }
      if (ownerTaggedMatches.size > 1) {
        return invalidSessionRequest(
          `Multiple sessions found for sessionId: ${sessionId} (${[...ownerTaggedMatches.values()]
            .map((match) => `${match.agentId}:${match.key}`)
            .join(", ")})`,
        );
      }
      const ownerTaggedMatch = ownerTaggedMatches.values().next().value;
      if (ownerTaggedMatch) {
        const check = prepareAgentChecks(
          [[ownerTaggedMatch.key, ownerTaggedMatch.entry]],
          ownerTaggedMatch.getTarget,
        )(ownerTaggedMatch.key, ownerTaggedMatch.entry);
        return (
          check ?? {
            ok: true,
            key: ownerTaggedMatch.key,
            agentId: ownerTaggedMatch.agentId,
          }
        );
      }
    }
    const { matches, getTarget } = sessionIdMatches(p.agentId);
    const selection = resolveSessionIdMatchSelection(matches, sessionId);
    if (selection.kind === "none") {
      return noSessionFoundResult(`No session found: ${sessionId}`);
    }
    if (selection.kind === "ambiguous") {
      return invalidSessionRequest(
        `Multiple sessions found for sessionId: ${sessionId} (${selection.sessionKeys.join(", ")})`,
      );
    }
    const selectedEntry = matches.find(([matchKey]) => matchKey === selection.sessionKey)?.[1];
    let selectedAgentId = parseAgentSessionKey(selection.sessionKey)?.agentId ?? p.agentId;
    if (!selectedAgentId) {
      const resolvedOwner = resolveRequestedSessionAgentId(cfg, selection.sessionKey);
      if (!resolvedOwner.ok) {
        return resolvedOwner;
      }
      selectedAgentId = resolvedOwner.agentId;
    }
    const agentCheckSessionId = prepareAgentChecks(matches, getTarget)(
      selection.sessionKey,
      selectedEntry,
    );
    if (agentCheckSessionId) {
      return agentCheckSessionId;
    }
    return { ok: true, key: selection.sessionKey, agentId: selectedAgentId };
  }

  if (hasShortId) {
    if (!SHORT_SESSION_ID_RE.test(rawShortId)) {
      return invalidSessionRequest("shortId must be 8-32 hexadecimal characters");
    }
    const shortId = rawShortId.toLowerCase();
    const prepared = prepare();
    const matchingEntries = filterAndSortSessionEntries({
      ...prepared,
      opts: { ...prepared.opts, archived: "all" },
      entryFilter: (candidateKey, entry) => {
        const uuid = parseAgentSessionKey(candidateKey)?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
        return Boolean(
          uuid?.toLowerCase().replaceAll("-", "").startsWith(shortId) &&
          (entryFilter?.(candidateKey, entry) ?? true),
        );
      },
    });
    const checkAgent = prepareAgentChecks(matchingEntries, prepared.getTarget);
    const matches = matchingEntries.flatMap(([candidateKey, entry]) => {
      const target = prepared.getTarget(candidateKey);
      return target && !checkAgent(candidateKey, entry)
        ? [sessionResolveCandidate(candidateKey, entry, target.agentId)]
        : [];
    });
    const slugHint = normalizeOptionalString(p.slugHint);
    const slugMatches = slugHint
      ? matches.filter((candidate) => controlUiSessionSlug(candidate.displayName) === slugHint)
      : [];
    // A stale display-name hint may narrow a tie, but it must never invalidate the id.
    const narrowed = slugMatches.length > 0 ? slugMatches : matches;
    if (narrowed.length === 0) {
      return noSessionFoundResult(`No session found: ${shortId}`);
    }
    if (narrowed.length > 1) {
      // Bound the ambiguity payload; callers treat a full ten rows as possibly truncated.
      return { ok: true, ambiguous: true, candidates: narrowed.slice(0, 10) };
    }
    const selected = expectDefined(narrowed[0], "short session match at 0");
    return { ok: true, ...selected };
  }

  const parsedLabel = parseSessionLabel(p.label);
  if (!parsedLabel.ok) {
    return invalidSessionRequest(parsedLabel.error);
  }

  const prepared = prepare();
  const matches = filterAndSortSessionEntries({
    ...prepared,
    entryFilter,
    opts: {
      ...resolveSessionVisibilityFilterOptions(p),
      label: parsedLabel.label,
      limit: 2,
    },
  });
  if (matches.length === 0) {
    return noSessionFoundResult(`No session found with label: ${parsedLabel.label}`);
  }
  if (matches.length > 1) {
    const keys = matches.map(([matchKey]) => matchKey).join(", ");
    return invalidSessionRequest(
      `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
    );
  }

  const [labelKey, labelEntry] = expectDefined(matches[0], "label session match at 0");
  const agentCheckLabel = prepareAgentChecks(matches, prepared.getTarget)(labelKey, labelEntry);
  if (agentCheckLabel) {
    return agentCheckLabel;
  }
  return {
    ok: true,
    key: labelKey,
    agentId: expectDefined(prepared.getTarget(labelKey), "label session agent").agentId,
  };
}
