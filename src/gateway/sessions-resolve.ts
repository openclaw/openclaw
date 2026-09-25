import { expectDefined } from "@openclaw/normalization-core";
// Gateway sessions.resolve implementation helper.
// Resolves key/sessionId/label/shortId selectors into one canonical session key.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveCandidate,
  type SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  controlUiSessionSlug,
  SESSION_UUID_SUFFIX_RE,
  SHORT_SESSION_ID_RE,
} from "../../packages/session-url-contract/src/index.js";
import { resolveLegacyFreeAcpSessionKey } from "../acp/runtime/session-meta-keys.js";
import { readAcpSessionMetaBatch } from "../acp/runtime/session-meta.js";
import { listAgentIds } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { hasOperatorBoundary } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
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

function resolveSessionVisibilityFilterOptions(p: SessionsResolveParams) {
  return {
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
    agentId: p.agentId,
  };
}

function noSessionFoundResult(params: { p: SessionsResolveParams; message: string }) {
  if (params.p.allowMissing) {
    return { ok: true, missing: true } as const;
  }
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, params.message),
  } as const;
}

/** Rejects sessions whose owning agent no longer exists in config (#65524). */
function validateSessionAgentExists(
  cfg: OpenClawConfig,
  key: string,
  entry?: SessionEntry | null,
  acpMeta?: SessionEntry["acp"] | null,
): SessionsResolveResult | null {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key, entry, { acpMeta });
  if (deletedAgentId === null) {
    return null;
  }
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Agent "${deletedAgentId}" no longer exists in configuration`,
    ),
  };
}

function normalizeShortSessionId(shortId: string): string | null {
  return SHORT_SESSION_ID_RE.test(shortId) ? shortId.toLowerCase() : null;
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
  if (key) {
    return withReadySessionRows(
      projection,
      (cfg) => {
        const agent = resolveRequestedSessionAgentId(cfg, key, p.agentId);
        return agent.ok ? [{ key, agentId: agent.agentId }] : [];
      },
      () => {
        assertCurrent();
        return consume(resolveSessionKeyFromResolveParams(params));
      },
    );
  }
  do {
    await projection.ensureMaterialized();
    assertCurrent();
  } while (projection.needsMaterialization);
  return consume(resolveSessionKeyFromResolveParams(params));
}

export function resolveSessionKeyFromResolveParams(params: {
  client: GatewayClient | null;
  projection: SessionRowProjection;
  p: SessionsResolveParams;
}): SessionsResolveResult {
  const { client, p, projection } = params;
  const { cfg, policyConfig } = projection.state;
  const { sharing } = prepareProjectedSessionPresentation(projection, client);
  const { entryFilter } = sharing;
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
    const unresolved: Parameters<typeof readAcpSessionMetaBatch>[0]["entries"][number][] = [];
    for (const [candidateKey, entry] of entries) {
      const agentId = parseAgentSessionKey(candidateKey)?.agentId;
      if (
        !agentId ||
        configuredAgentIds.has(agentId) ||
        !resolveLegacyFreeAcpSessionKey(candidateKey)
      ) {
        continue;
      }
      const source = getTarget(candidateKey)?.materialized?.source;
      if (entry.acp || source?.entry === entry) {
        facts.set(entry, entry.acp ?? source?.thinkingProjection.acpMeta);
      } else {
        unresolved.push({ sessionKey: candidateKey, agentId, entry });
      }
    }
    if (unresolved.length) {
      for (const [entry, meta] of readAcpSessionMetaBatch({ cfg, entries: unresolved })) {
        facts.set(entry, meta);
      }
    }
    return (candidateKey: string, entry: SessionEntry | undefined) =>
      validateSessionAgentExists(
        cfg,
        candidateKey,
        entry,
        (entry && facts.get(entry)) ?? entry?.acp ?? null,
      );
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
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "slugHint requires shortId"),
    };
  }
  const selectionCount = [hasKey, hasSessionId, hasLabel, hasShortId, hasReference].filter(
    Boolean,
  ).length;
  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, label, shortId, or reference (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Either key, sessionId, label, shortId, or reference is required",
      ),
    };
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
      : noSessionFoundResult({ p, message: `No session found: ${p.reference.key}` });
  }

  if (hasKey) {
    // Exact-key lookup follows the proof-of-knowledge read semantics of get/describe/history;
    // only discovery selectors use list visibility. Incognito keys are gated pre-dispatch.
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      return requestedAgent;
    }
    if (authorizeIncognitoSessionTarget({ client, sessionKey: key, target: null })) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    const target = projection.describe({ agentId: requestedAgent.agentId, key });
    if (target?.entry) {
      const { entry } = target;
      const spawnedBy = typeof p.spawnedBy === "string" && p.spawnedBy.trim().length > 0;
      if (
        (hasOperatorBoundary(client, policyConfig) && entryFilter?.(target.key, entry) === false) ||
        (spawnedBy &&
          !filterAndSortSessionEntries({ ...prepare(requestedAgent.agentId) }).some(
            ([candidate]) => candidate === target.key,
          ))
      ) {
        return noSessionFoundResult({ p, message: `No session found: ${key}` });
      }
      return (
        prepareAgentChecks([[target.key, entry]], () => target)(target.key, entry) ?? {
          ok: true,
          key: target.key,
          agentId: requestedAgent.agentId,
        }
      );
    }
    return noSessionFoundResult({ p, message: `No session found: ${key}` });
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
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Multiple sessions found for sessionId: ${sessionId} (${agentSelection.sessionKeys.join(", ")})`,
            ),
          };
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
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Multiple sessions found for sessionId: ${sessionId} (${[...ownerTaggedMatches.values()]
              .map((match) => `${match.agentId}:${match.key}`)
              .join(", ")})`,
          ),
        };
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
      return noSessionFoundResult({ p, message: `No session found: ${sessionId}` });
    }
    if (selection.kind === "ambiguous") {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${selection.sessionKeys.join(", ")})`,
        ),
      };
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
    const shortId = normalizeShortSessionId(rawShortId);
    if (!shortId) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "shortId must be 8-32 hexadecimal characters",
        ),
      };
    }
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
      return noSessionFoundResult({ p, message: `No session found: ${shortId}` });
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
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
    };
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
    return noSessionFoundResult({
      p,
      message: `No session found with label: ${parsedLabel.label}`,
    });
  }
  if (matches.length > 1) {
    const keys = matches.map(([matchKey]) => matchKey).join(", ");
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
      ),
    };
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
