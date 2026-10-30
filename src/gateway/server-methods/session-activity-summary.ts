import {
  ErrorCodes,
  errorShape,
  validateSessionsActivitySummaryEnsureParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  prepareSessionMutationFacts,
  type PreparedSessionSourceFacts,
  type SessionFactsRead,
} from "../session-sharing-preparation.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "../session-sharing-read.js";
import { authorizeIncognitoSessionTarget } from "../session-sharing.js";
import { withGatewaySessionStoreTarget } from "../session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../session-utils-store.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const sessionActivitySummaryHandlers: GatewayRequestHandlers = {
  "sessions.activitySummary.ensure": defineValidatedGatewayHandler(
    "sessions.activitySummary.ensure",
    validateSessionsActivitySummaryEnsureParams,
    async ({ params, client, context, respond }) => {
      const service = context.sessionActivitySummaries;
      if (!service) {
        respondError(respond, ErrorCodes.UNAVAILABLE, "Activity recaps are unavailable.");
        return;
      }
      const cfg = context.getRuntimeConfig();
      const profiles = await prepareSessionSharingProfiles(client);
      const reads: SessionFactsRead<PreparedSessionSourceFacts>[] = [];
      try {
        const requestedTargets = [];
        for (const requested of params.sessions) {
          const agent = resolveRequestedSessionAgentId(cfg, requested.key, requested.agentId);
          if (!agent.ok) {
            respond(false, undefined, agent.error);
            return;
          }
          requestedTargets.push({ requested, agentId: agent.agentId });
        }
        const preparations = await Promise.allSettled(
          requestedTargets.map(async ({ requested, agentId }) => {
            if (isIncognitoSessionKey(requested.key)) {
              return undefined;
            }
            const [sharing, entry] = await Promise.allSettled([
              prepareSessionMutationFacts({
                cfg,
                sessionKey: requested.key,
                agentId,
                allowMissing: true,
              }).then((read) => {
                reads.push(read);
                return read;
              }),
              withGatewaySessionStoreTarget(
                { cfg, key: requested.key, agentId, projection: "list" },
                (target) =>
                  resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys),
              ),
            ]);
            if (sharing.status === "rejected") {
              throw sharing.reason;
            }
            if (entry.status === "rejected") {
              throw entry.reason;
            }
            return { read: sharing.value, entry: entry.value };
          }),
        );
        const prepared = preparations.map((result) => {
          if (result.status === "rejected") {
            throw result.reason;
          }
          return result.value;
        });
        const targets = [];
        // Authorize the complete batch before enqueueing any model work.
        for (const [index, { requested, agentId }] of requestedTargets.entries()) {
          if (isIncognitoSessionKey(requested.key)) {
            const error = authorizeIncognitoSessionTarget({
              client,
              sessionKey: requested.key,
              target: null,
            });
            if (error) {
              respond(false, undefined, error);
              return;
            }
            targets.push({ key: requested.key, agentId, unavailable: true });
            continue;
          }
          const currentCfg = context.getRuntimeConfig();
          const selected = prepared[index]!;
          const facts = selected.read.readCurrent(currentCfg);
          const target = facts.target;
          const sharing = prepareProjectedSessionSharing({
            cfg: currentCfg,
            client,
            profiles,
            isMember: (_target, id) => facts.membership.has(id),
          });
          if (
            !target ||
            !selected.entry ||
            selected.entry.sessionId !== target.entry.sessionId ||
            selected.entry.lifecycleRevision !== target.entry.lifecycleRevision ||
            (hasOperatorBoundary(client, currentCfg) && !sharing.canReadTarget(target))
          ) {
            respondError(respond, ErrorCodes.INVALID_REQUEST, "Session is unavailable.");
            return;
          }
          const error =
            authorizeIncognitoSessionTarget({ client, sessionKey: requested.key, target }) ??
            sharing.authorizeTarget(target);
          if (error) {
            respond(false, undefined, error);
            return;
          }
          targets.push({
            key: target.canonicalKey,
            agentId: target.agentId,
            entry: { ...selected.entry, ...target.entry },
          });
        }
        const sessions = await Promise.all(
          targets.map(async (target) => ({
            key: target.key,
            agentId: target.agentId,
            activitySummary: {
              ...(target.unavailable
                ? { state: "unavailable" as const }
                : await service.ensure(target, target.entry)),
              canEnsure: true,
            },
          })),
        );
        const currentCfg = context.getRuntimeConfig();
        for (const [index, { requested }] of requestedTargets.entries()) {
          const selected = prepared[index];
          if (!selected) {
            continue;
          }
          const facts = selected.read.readCurrent(currentCfg);
          const target = facts.target;
          const sharing = prepareProjectedSessionSharing({
            cfg: currentCfg,
            client,
            profiles,
            isMember: (_target, id) => facts.membership.has(id),
          });
          const error = target
            ? (authorizeIncognitoSessionTarget({ client, sessionKey: requested.key, target }) ??
              sharing.authorizeTarget(target))
            : errorShape(ErrorCodes.INVALID_REQUEST, "Session is unavailable.");
          if (
            error ||
            (target && hasOperatorBoundary(client, currentCfg) && !sharing.canReadTarget(target))
          ) {
            respond(
              false,
              undefined,
              error ?? errorShape(ErrorCodes.INVALID_REQUEST, "Session is unavailable."),
            );
            return;
          }
        }
        respond(true, { sessions });
      } finally {
        for (const read of reads) {
          read.release();
        }
      }
    },
  ),
};
