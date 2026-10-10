import { randomUUID } from "node:crypto";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  RuntimeSessionFactsResult,
  RuntimeSessionFactsSelection,
  RuntimeSessionFactsSelectionResult,
} from "../plugins/runtime/types-session-facts.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import { operatorReadShareKey } from "./methods/read-share-keys.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { withInProcessGatewayRead } from "./server-plugin-in-process-dispatch.js";
import { canTrustedOfficialPluginRequestScopes } from "./server-plugin-subagent-runtime.js";
import { sessionClassificationForRow } from "./session-classification.js";
import {
  prepareFactsRead,
  safeText,
  sessionFactsRedactionPolicy,
  type SelectedFacts,
  type SelectedPrFacts,
} from "./session-facts-read.js";
import { transientSessionKeys } from "./session-facts-transient.js";
import type { SessionEntrySelection } from "./session-list-filters.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "./session-row-projection-access.js";
import type { SelectionRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionVisibility } from "./session-sharing.js";
import { prepareProjectedSessionList, selectSessionEntries } from "./session-utils-list.js";

const SESSION_FACTS_LIMIT = 40;
const selectedPrFacts = new WeakMap<SessionRowProjection, Map<string, SelectedPrFacts>>();
type SelectedRoster = {
  revision: object;
  at: number;
  selected: SessionEntrySelection;
  targets: Map<string, SelectionRow>;
  bySessionId: Map<string, Set<string>>;
};
type ReadScope = {
  token: string;
  visibility: WeakMap<object, boolean>;
  snapshot?: RuntimeSessionFactsSelectionResult;
  roster?: SelectedRoster;
  facts: Map<string, { entry: SelectionRow["entry"]; facts: SelectedFacts }>;
  dirty: Map<string, object>;
  transient: Set<string>;
  reset: object;
  completedReset?: object;
};

function createReadScope(token: string): ReadScope {
  return {
    token,
    visibility: new WeakMap(),
    facts: new Map(),
    dirty: new Map(),
    transient: new Set(),
    reset: {},
  };
}

const readScopes = new WeakMap<
  object,
  {
    config: object;
    configRevision: number | undefined;
    policy: object | undefined;
    access: number;
    profiles: number;
    redaction: ReturnType<typeof sessionFactsRedactionPolicy>;
    scopes: Map<string, ReadScope>;
  }
>();

function trustedScope() {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error("Session facts are only available to bundled or trusted official plugins");
  }
  return scope;
}

/** The published exact-key API retains its bounded acquisition and response contract. */
export async function readTrustedPluginSessionFacts(
  params: { sessionKeys: readonly string[] },
  resolveGatewayContext?: GatewayContextResolver,
): Promise<RuntimeSessionFactsResult> {
  if (
    !Array.isArray(params.sessionKeys) ||
    params.sessionKeys.length > SESSION_FACTS_LIMIT ||
    params.sessionKeys.some(
      (key) =>
        typeof key !== "string" || !key.trim() || key.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH,
    )
  ) {
    throw new Error(
      `Session facts require at most 40 nonempty session keys of at most ${CHAT_SEND_SESSION_KEY_MAX_LENGTH} characters`,
    );
  }
  const keys = [...new Set(params.sessionKeys.map((key) => key.trim()))].filter(
    (key) => !isIncognitoSessionKey(key),
  );
  return withInProcessGatewayRead(
    {
      method: "sessions.list",
      scope: trustedScope(),
      resolveGatewayContext,
      callerAuthorityError: "Session facts caller authority is no longer active",
    },
    async (resolved, assertCurrent) => {
      const projection = requireSessionRowProjection(resolved.context);
      return withReadySessionRows(
        projection,
        (cfg) =>
          keys.flatMap((key) => {
            const requested = resolveRequestedSessionAgentId(cfg, key);
            return requested.ok ? [{ key, agentId: requested.agentId }] : [];
          }),
        (read) =>
          withAgentRosterFactsBatch(read.state.cfg, () => {
            assertCurrent();
            const facts = prepareFactsRead(resolved, read);
            const sessions = keys.flatMap((key) => {
              const requested = resolveRequestedSessionAgentId(read.state.cfg, key);
              const record = requested.ok
                ? read.describe({ key, agentId: requested.agentId })
                : undefined;
              return (record && facts.read(record)?.facts) ?? [];
            });
            facts.finish();
            return {
              sessions,
              ...(sessions.some((row) => row.pullRequestsUnavailable)
                ? { warnings: ["Pull-request state is unavailable for some sessions."] }
                : {}),
            };
          }),
      );
    },
  );
}

/** Select once through the list owner, then retain caller authority through the plugin consumer. */
export async function withTrustedPluginSessionFacts<T>(
  select: RuntimeSessionFactsSelection,
  run: (snapshot: RuntimeSessionFactsSelectionResult) => Promise<T>,
  resolveGatewayContext?: GatewayContextResolver,
): Promise<T> {
  const requestScope = trustedScope();
  return withInProcessGatewayRead(
    {
      method: "sessions.list",
      scope: requestScope,
      resolveGatewayContext,
      callerAuthorityError: "Session facts caller authority is no longer active",
    },
    async (resolved, assertCurrent) => {
      const { context } = resolved;
      const projection = requireSessionRowProjection(context);
      const callerKey = () => operatorReadShareKey({ client: requestScope?.client ?? null }, {});
      const authorityKey = callerKey();
      const scopeKey = JSON.stringify([authorityKey, select]);
      const config = context.getRuntimeConfig();
      const configRevision = getRuntimeConfigSnapshotMetadata()?.revision;
      const policy = context.getCommittedRuntimeConfig?.();
      const access = readGatewayAccessRevision();
      const profiles = readUserProfileVersion();
      const redaction = sessionFactsRedactionPolicy();
      const assertAuthority = () => {
        assertCurrent();
        if (
          callerKey() !== authorityKey ||
          getSessionRowProjection(context) !== projection ||
          context.getRuntimeConfig() !== config ||
          getRuntimeConfigSnapshotMetadata()?.revision !== configRevision ||
          context.getCommittedRuntimeConfig?.() !== policy ||
          readGatewayAccessRevision() !== access ||
          readUserProfileVersion() !== profiles ||
          sessionFactsRedactionPolicy() !== redaction
        ) {
          throw new Error("Session read authority changed; retry the request");
        }
      };
      let authority: ReadScope | undefined;
      if (authorityKey !== null) {
        let entry = readScopes.get(projection);
        if (!entry) {
          projection.onFactsChange((change) => {
            for (const scope of readScopes.get(projection)?.scopes.values() ?? []) {
              if (change.kind === "reset" || !scope.roster) {
                scope.reset = {};
                scope.dirty.clear();
              } else if (scope.roster.targets.has(change.key)) {
                scope.dirty.set(change.key, {});
              }
            }
          });
        }
        if (
          !entry ||
          entry.config !== config ||
          entry.configRevision !== configRevision ||
          entry.policy !== policy ||
          entry.access !== access ||
          entry.profiles !== profiles ||
          entry.redaction !== redaction
        ) {
          entry = {
            config,
            configRevision,
            policy,
            access,
            profiles,
            redaction,
            scopes: new Map(),
          };
          readScopes.set(projection, entry);
        }
        authority = entry.scopes.get(scopeKey);
        if (!authority) {
          if (entry.scopes.size >= 64) {
            entry.scopes.delete(entry.scopes.keys().next().value!);
          }
          authority = createReadScope(randomUUID());
          entry.scopes.set(scopeKey, authority);
        }
      }
      let prFacts = selectedPrFacts.get(projection);
      if (!prFacts) {
        prFacts = new Map();
        selectedPrFacts.set(projection, prFacts);
        const current = prFacts;
        projection.onSelectionChange((change) => {
          if (change.kind === "row" && !change.row) {
            current.delete(change.key);
          }
        });
      }
      const currentPrFacts = prFacts;
      const cache = authority ?? createReadScope("");
      const snapshot = await projection.withSelectionPreparation(async () => {
        do {
          await projection.prepareSelection(true);
          await projection.prepareMembership();
          assertAuthority();
        } while (projection.needsSelectionPreparation());
        const previous = cache.snapshot;
        const previousRoster = cache.roster;
        const previousFacts = cache.facts;
        const previousTransient = cache.transient;
        const reset = cache.reset;
        const at = Date.now();
        const projectionState = projection.state;
        const full = !previous || cache.completedReset !== reset;
        let roster = previousRoster;
        if (
          full ||
          !roster ||
          roster.revision !== projectionState.revision ||
          at < roster.at ||
          at > (roster.selected.activityExpiresAt ?? Infinity)
        ) {
          const opts = { ...select, limit: Number.MAX_SAFE_INTEGER };
          const { prepared, filters, presentation } = prepareProjectedSessionList({
            projection,
            opts,
            context,
            client: resolved.client,
            now: at,
            metadataPrepared: true,
            visibility: authority?.visibility,
          });
          const selected = presentation.select(opts, () =>
            withAgentRosterFactsBatch(prepared.cfg, () =>
              runSynchronousWork(selectSessionEntries(filters)),
            ),
          );
          const targets = new Map<string, SelectionRow>();
          const bySessionId = new Map<string, Set<string>>();
          for (const [key] of selected.entries) {
            const target = prepared.getTarget(key);
            if (!target) {
              continue;
            }
            targets.set(key, target);
            const aliases = bySessionId.get(target.entry.sessionId) ?? new Set<string>();
            aliases.add(key);
            bySessionId.set(target.entry.sessionId, aliases);
          }
          roster = { revision: projectionState.revision, at, selected, targets, bySessionId };
        }
        const currentRoster = roster;
        const transient = transientSessionKeys(context, projectionState.rowContext, currentRoster);
        const wanted = new Set([...cache.dirty.keys(), ...previousTransient, ...transient]);
        for (const [key, retained] of currentPrFacts) {
          if (currentRoster.targets.has(key) && retained.retry && retained.retry.at <= at) {
            wanted.add(key);
          }
        }
        if (full || currentRoster !== previousRoster) {
          for (const [key, target] of currentRoster.targets) {
            if (full || previousFacts.get(key)?.entry !== target.entry) {
              wanted.add(key);
            }
          }
        }
        if (!wanted.size && currentRoster === previousRoster && previous) {
          return previous;
        }
        const observed = new Map<string, object | undefined>(cache.dirty);
        const updates = new Map<string, SelectedFacts | undefined>();
        const missingSessionKeys: string[] = [];
        let complete = true;
        const work = [...wanted].flatMap((key) => {
          const target = currentRoster.targets.get(key);
          return target ? [{ key, target }] : [];
        });
        for (let offset = 0; offset < work.length; offset += SESSION_FACTS_LIMIT) {
          const batch = work.slice(offset, offset + SESSION_FACTS_LIMIT);
          try {
            const batchRows = await withReadySessionRows(
              projection,
              () =>
                batch.map(({ target }) => ({
                  key: target.key,
                  agentId: target.agentId,
                  storePath: target.storeTarget.storePath,
                })),
              (read) =>
                withAgentRosterFactsBatch(read.state.cfg, () => {
                  assertAuthority();
                  const facts = prepareFactsRead(resolved, read, authority, currentPrFacts);
                  const rows = batch.map(({ key, target }) => {
                    const record = read.describe({
                      key: target.key,
                      agentId: target.agentId,
                      storePath: target.storeTarget.storePath,
                    });
                    const current =
                      record?.entry.sessionId === target.entry.sessionId
                        ? facts.read(record)?.selected
                        : undefined;
                    // Live owners may start after the pre-acquisition inventory.
                    if (current?.run === "active") {
                      transient.add(key);
                    }
                    observed.set(key, cache.dirty.get(key));
                    return { key, target, current };
                  });
                  facts.finish();
                  return rows;
                }),
            );
            for (const { key, target, current } of batchRows) {
              updates.set(key, current);
              if (
                !current &&
                !target.entry.incognito &&
                resolveSessionVisibility(target.entry) !== "draft" &&
                !isIncognitoSessionKey(key)
              ) {
                missingSessionKeys.push(key);
                complete = false;
              }
            }
          } catch (error) {
            assertAuthority();
            complete = false;
            const unavailable = redactToolPayloadText(String(error))
              .replace(/\s+/g, " ")
              .slice(0, 300);
            for (const { key, target } of batch) {
              const { entry } = target;
              if (
                entry.incognito ||
                resolveSessionVisibility(entry) === "draft" ||
                isIncognitoSessionKey(key)
              ) {
                continue;
              }
              const fallback: SelectedFacts = {
                key,
                sessionId: entry.sessionId,
                agentId: target.agentId,
                label: safeText(entry.label, 240),
                derivedTitle: safeText(entry.autoLabel, 240),
                run: "idle",
                pullRequests: [],
                pullRequestsUnavailable: true,
                archived: entry.archivedAt !== undefined,
                lastActivityAt: entry.lastActivityAt ?? entry.updatedAt ?? 0,
                isMain: sessionClassificationForRow(config, key, target.agentId, entry).isMain,
                unavailable,
              };
              updates.set(key, freezeJsonSnapshot(fallback));
            }
          }
        }
        assertAuthority();
        let retryAt = Infinity;
        for (const [key, retained] of currentPrFacts) {
          if (currentRoster.targets.has(key)) {
            retryAt = Math.min(retryAt, retained.retry?.at ?? Infinity);
          }
        }
        const sameRows =
          previous &&
          currentRoster === previousRoster &&
          [...updates].every(([key, row]) => row === previousFacts.get(key)?.facts);
        let result = previous;
        let nextFacts = previousFacts;
        if (
          !complete ||
          !sameRows ||
          previous?.retryAt !== (Number.isFinite(retryAt) ? retryAt : undefined)
        ) {
          nextFacts = new Map();
          const sessions: SelectedFacts[] = [];
          for (const [key, target] of currentRoster.targets) {
            const facts = updates.has(key) ? updates.get(key) : previousFacts.get(key)?.facts;
            if (!facts) {
              continue;
            }
            nextFacts.set(key, { entry: target.entry, facts });
            sessions.push(facts);
          }
          Object.freeze(sessions);
          Object.freeze(missingSessionKeys);
          result = Object.freeze({
            scope: authority?.token,
            revision: randomUUID(),
            redactionRevision: redaction.revision,
            sessions,
            ...(currentRoster.selected.people !== undefined
              ? { people: currentRoster.selected.people }
              : {}),
            ...(currentRoster.selected.activityExpiresAt !== undefined
              ? { activityExpiresAt: currentRoster.selected.activityExpiresAt }
              : {}),
            ...(Number.isFinite(retryAt) ? { retryAt } : {}),
            ...(missingSessionKeys.length ? { missingSessionKeys } : {}),
          });
        }
        const installed = cache.snapshot;
        if (
          complete &&
          installed &&
          installed !== previous &&
          result &&
          cache.completedReset === reset &&
          cache.reset === reset &&
          cache.roster?.selected === currentRoster.selected &&
          installed.retryAt === result.retryAt &&
          installed.sessions.length === result.sessions.length &&
          installed.sessions.every((row, index) => row === result.sessions[index])
        ) {
          return installed;
        }
        // A later read or broad reset owns installation; keyed publications remain pending until observed.
        if (
          complete &&
          authority &&
          cache.snapshot === previous &&
          cache.reset === reset &&
          currentRoster.revision === projection.state.revision
        ) {
          cache.snapshot = result;
          cache.roster = currentRoster;
          cache.facts = nextFacts;
          cache.transient = transient;
          cache.completedReset = reset;
          for (const [key, token] of observed) {
            if (cache.dirty.get(key) === token) {
              cache.dirty.delete(key);
            }
          }
        }
        return result!;
      });
      const result = await run(snapshot);
      assertAuthority();
      return result;
    },
  );
}
