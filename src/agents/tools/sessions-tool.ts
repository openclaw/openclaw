import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionsAssignOwnerResult,
  SessionsPatchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { appendSessionTranscriptReport } from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import {
  runWithoutOwnedSessionTranscriptWrites,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayTransportError } from "../../gateway/call.js";
import { withAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isTransientNetworkError } from "../../infra/unhandled-rejections.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  captureSessionControllerSettlement,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  wrapGatewayPersonalToolExecution,
} from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  getInProcessGatewayToolContext,
  hasInProcessGatewayToolContext,
  runWithGatewayToolContinuationContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { resolveSessionToolTargetAgentId } from "./scoped-session-access.js";
import {
  formatSessionToolAccessDenial,
  recordSessionToolActionFact,
  resolveSessionToolAccess,
  runSessionToolActionWithConflictReceipt,
} from "./sessions-access.js";
import { listSessionCloudProfiles } from "./sessions-cloud-profiles.js";
import { isSessionToolMainAlias, resolveSessionToolContext } from "./sessions-helpers.js";
import {
  captureSessionControlAuthority,
  hasSessionControlAuthority,
  hasSessionWriteAuthority,
} from "./sessions-operator-authority.js";
import { listSessionOwnerProfiles } from "./sessions-owner-profiles.js";
import { resolveSessionReference, shouldResolveSessionIdInput } from "./sessions-resolution.js";
import {
  callSessionToolControl,
  captureSessionStopCaller,
  prepareSessionToolControlTarget,
  stopSessionTool,
} from "./sessions-tool-control.js";
import {
  readSessionsToolPatch,
  runSessionsToolPatchMany,
  withBoundedSessionsResolved,
} from "./sessions-tool-patch.js";
import {
  SessionControlToolSchema,
  SessionRenameToolSchema,
  resolveSessionsToolSchema,
} from "./sessions-tool-schema.js";

const GROUP_NAME_MAX_LENGTH = 512;
const log = createSubsystemLogger("agents/sessions");

type SessionsToolOptions = {
  senderIsOwner?: boolean;
  sandboxSessionRenameOnly?: boolean;
  sessionControlAuthority?: AdmittedRunOperatorAuthority;
  stopAllowed?: boolean;
  agentSessionKey?: string;
  agentSessionId?: string;
  requesterAgentIdOverride?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: AgentToolGatewayRequestCaller;
  hasInProcessGatewayContext?: () => boolean;
};

function readGroupName(value: unknown, label: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new ToolInputError(`${label} required`);
  }
  if (name.length > GROUP_NAME_MAX_LENGTH) {
    throw new ToolInputError(`${label} too long`);
  }
  return name;
}

async function resolvePatchTarget(
  opts: SessionsToolOptions,
  sessionKey: string | undefined,
  callGateway: AgentToolGatewayRequestCaller,
): Promise<{
  agentId: string;
  cfg: OpenClawConfig;
  isRequesterSession: boolean;
  key: string;
  requesterAgentId: string;
  requesterSessionKey: string;
}> {
  const context = resolveSessionToolContext(opts);
  const rawKey = sessionKey ?? context.effectiveRequesterKey;
  const requesterAgentId = resolveSessionAgentId({
    config: context.cfg,
    sessionKey: context.effectiveRequesterKey,
    agentId: opts.requesterAgentIdOverride,
  });
  const normalizedRawKey = rawKey.trim();
  const isCurrentSession = normalizedRawKey === "current";
  const isConfiguredMainAlias = isSessionToolMainAlias(normalizedRawKey, context);
  const inputAgentId = isCurrentSession
    ? requesterAgentId
    : shouldResolveSessionIdInput(rawKey) && !isConfiguredMainAlias
      ? undefined
      : resolveSessionToolTargetAgentId({
          cfg: context.cfg,
          targetSessionKey: rawKey,
          requesterAgentId,
        });
  const resolved = await resolveSessionReference({
    action: "status",
    sessionKey: rawKey,
    agentId: inputAgentId,
    keyAgentId: requesterAgentId,
    alias: context.alias,
    mainKey: context.mainKey,
    requesterInternalKey: context.effectiveRequesterKey,
    restrictToSpawned: context.restrictToSpawned,
    callGateway,
  });
  if (!resolved.ok) {
    throw new ToolInputError(resolved.error);
  }
  if (isIncognitoSessionKey(resolved.key)) {
    throw new ToolAuthorizationError(`Session not visible from session tools: ${rawKey}`);
  }
  const agentId = resolveSessionToolTargetAgentId({
    cfg: context.cfg,
    targetSessionKey: resolved.key,
    resolvedAgentId: resolved.agentId,
    requesterAgentId,
  });
  const isRequesterSession =
    resolved.key === context.effectiveRequesterKey && agentId === requesterAgentId;
  if (!isRequesterSession) {
    // Session controls require status visibility, never an outbound-only send grant.
    // Owner gating remains separate.
    const authorizationKey =
      agentId !== requesterAgentId && !parseAgentSessionKey(resolved.key)
        ? `agent:${agentId}:${resolved.key}`
        : resolved.key;
    const access = await resolveSessionToolAccess({
      action: "status",
      requesterSessionKey: context.effectiveRequesterKey,
      mainSessionKey: context.mainSessionKey,
      authorizationTargetSessionKey: authorizationKey,
      requesterAgentId,
      targetAgentId: agentId,
      targetSessionKey: resolved.key,
      requesterOwned: resolved.requesterOwned,
      visibility: context.sessionVisibility,
      a2aPolicy: context.a2aPolicy,
      callGateway,
    });
    if (!access.allowed) {
      throw new ToolAuthorizationError(
        formatSessionToolAccessDenial(access, {
          action: "status",
          targetSessionKey: resolved.displayKey,
        }),
      );
    }
  }
  return {
    agentId,
    cfg: context.cfg,
    isRequesterSession,
    key: resolved.key,
    requesterAgentId,
    requesterSessionKey: context.effectiveRequesterKey,
  };
}

export function createSessionsTool(opts: SessionsToolOptions = {}): AnyAgentTool {
  // Absence is the existing senderless system surface, not an explicit non-owner.
  const sandboxRenameOnly = opts.sandboxSessionRenameOnly === true;
  const controlOnly = opts.senderIsOwner === false || sandboxRenameOnly;
  const renameAllowed = controlOnly && hasSessionWriteAuthority(opts.sessionControlAuthority);
  const renameOnly = controlOnly && !hasSessionControlAuthority(opts.sessionControlAuthority);
  const assignmentOnly = renameOnly && !renameAllowed;
  const stopAllowed = opts.stopAllowed !== false;
  const gatewayRequest = opts.callGateway ?? callAgentToolGatewayRequest;
  const callGateway = <T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ) => gatewayRequest<T>({ method, params });
  return {
    label: "Sessions",
    name: "sessions",
    // Only session-stable facts pick the definition, so every turn of a session
    // offers the same tool; per-turn authority is enforced when it runs.
    description: sandboxRenameOnly
      ? "Rename a session created by the requesting operator with patch and label (empty string clears it). Default target: current session. Another session requires sessionKey and expectedSessionId from sessions_list. Archive and restore are unavailable in this authority context. No other session actions or settings."
      : `cloud_profiles lists configured cloud profiles; pass profileId for their OS and machine choices. owner_profiles lists canonical human profile IDs; optional githubAccountIds resolves verified account mappings. Session settings, ownership, ${stopAllowed ? "stop, " : ""}reset, delete, and custom sidebar groups: patch label/icon/group/status, pin, archive/restore, model/thinking override. patch with group files sessions into a group; targets applies the same patch to up to 100 visible sessions; group_list shows the catalog; group_set replaces the whole ordered catalog; group_rename/group_delete change one group everywhere. assign_owner hands responsibility to a human or agent, not access. Report unresolved ownership separately and continue independently authorized work. reset/delete visible sessions. Turns without owner authority are limited when the action runs.`,
    parameters: sandboxRenameOnly
      ? SessionRenameToolSchema
      : resolveSessionsToolSchema(stopAllowed),
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, rawArgs, signal) => {
      let params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      const restrictedRename =
        controlOnly &&
        action === "patch" &&
        typeof params.label === "string" &&
        Object.keys(params).every((key) => Object.hasOwn(SessionRenameToolSchema.properties, key));
      if (sandboxRenameOnly && !restrictedRename) {
        throw new ToolAuthorizationError("This sandbox session tool only permits renaming");
      }
      if (action === "stop" && !stopAllowed) {
        throw new ToolAuthorizationError(
          "Session Stop is unavailable to non-interactive collectors",
        );
      }
      if (assignmentOnly && action !== "assign_owner") {
        throw new ToolAuthorizationError("Only assign_owner is available to non-owner callers");
      }
      if (restrictedRename) {
        // Policy hooks can supply prototype defaults; retain only the declared rename fields.
        params = Object.fromEntries(
          Object.keys(SessionRenameToolSchema.properties).map((key) => [key, params[key]]),
        );
        if (!hasSessionWriteAuthority()) {
          throw new ToolAuthorizationError(
            "Session rename requires current session write authority",
          );
        }
      } else if (controlOnly && action !== "assign_owner") {
        // Discovery is not a grant: retained tools cannot fall back to System
        // dispatch after their human caller or invocation has gone away.
        if (!hasSessionControlAuthority()) {
          throw new ToolAuthorizationError(
            "Session control requires a current operator write grant",
          );
        }
        if (
          (action !== "patch" && action !== "stop") ||
          (action === "patch" &&
            (typeof params.archived !== "boolean" ||
              params.runId !== undefined ||
              params.clearQueued !== undefined)) ||
          (action === "stop" && params.archived !== undefined) ||
          Object.keys(params).some(
            (key) => !Object.hasOwn(SessionControlToolSchema.properties, key),
          )
        ) {
          throw new ToolAuthorizationError(
            "This session tool only permits archive, restore, and stop",
          );
        }
      }
      if (
        params.targets !== undefined &&
        (action !== "patch" ||
          params.sessionKey !== undefined ||
          params.expectedSessionId !== undefined)
      ) {
        throw new ToolInputError(
          "targets is only valid for patch and cannot be combined with sessionKey or expectedSessionId",
        );
      }
      if (action === "stop") {
        const caller = captureSessionStopCaller();
        const target = await resolvePatchTarget(
          opts,
          readToolStringParam(params, "sessionKey"),
          gatewayRequest,
        );
        return await stopSessionTool(
          {
            ...target,
            operation: "stop",
            restricted: controlOnly,
            expectedSessionId: readToolStringParam(params, "expectedSessionId"),
          },
          params,
          gatewayRequest,
          caller,
          signal,
        );
      }
      if (action === "reset" || action === "delete") {
        const rawKey = readToolStringParam(params, "sessionKey", { required: true });
        const { agentId, isRequesterSession, key } = await resolvePatchTarget(
          opts,
          rawKey,
          gatewayRequest,
        );
        if (isRequesterSession) {
          throw new ToolInputError(`Cannot ${action} the session running this tool`);
        }
        const agentScope = parseAgentSessionKey(key) ? {} : { agentId };
        let mutationParams: Record<string, unknown> = { key, ...agentScope, reason: "reset" };
        if (action === "delete") {
          // Archive returns the exact row generation. Carry it into the locked
          // delete so a concurrent reset cannot delete a replacement session.
          const expectedSessionId = readToolStringParam(params, "expectedSessionId");
          if (!expectedSessionId) {
            throw new ToolInputError(
              "Session lifecycle action requires a durable session identity",
            );
          }
          const archived = await runSessionToolActionWithConflictReceipt({
            operation: action,
            targetAgentId: agentId,
            targetSessionKey: key,
            run: async () =>
              await callGateway<{
                entry?: { sessionId?: string; lifecycleRevision?: string };
              }>("sessions.patch", {
                key,
                ...agentScope,
                expectedSessionId,
                archived: true,
              }),
          });
          const archivedSessionId = normalizeOptionalString(archived.entry?.sessionId);
          if (!archivedSessionId) {
            throw new ToolInputError("Session archive did not return its session identity");
          }
          const expectedLifecycleRevision = normalizeOptionalString(
            archived.entry?.lifecycleRevision,
          );
          mutationParams = {
            key,
            ...agentScope,
            archivedOnly: true,
            expectedSessionId: archivedSessionId,
            ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}),
          };
        }
        const result = await runSessionToolActionWithConflictReceipt({
          operation: action,
          targetAgentId: agentId,
          targetSessionKey: key,
          run: async () => {
            if (action === "delete") {
              const deleteTranscript = params.deleteTranscript;
              if (deleteTranscript !== undefined && typeof deleteTranscript !== "boolean") {
                throw new ToolInputError("deleteTranscript must be boolean");
              }
              mutationParams.deleteTranscript = deleteTranscript ?? true;
            }
            return await callGateway(`sessions.${action}`, mutationParams);
          },
        });
        recordSessionToolActionFact({
          operation: action,
          // Delete's archive is part of this action and already committed.
          // A delete miss therefore cannot make the whole operation a no-op.
          fact: "committed",
          targetAgentId: agentId,
          targetSessionKey: key,
        });
        return jsonResult(result);
      }
      if (action === "owner_profiles") {
        return await listSessionOwnerProfiles(params, gatewayRequest);
      }
      if (action === "cloud_profiles") {
        return await listSessionCloudProfiles(params, gatewayRequest);
      }
      if (action === "group_list") {
        return jsonResult(await callGateway("sessions.groups.list", {}));
      }
      if (action === "assign_owner") {
        // Responsibility assignment uses the live agent caller, not the assignee authority.
        const assertCallerCurrent = captureGatewayToolCallerAssertion();
        if (opts.senderIsOwner !== true && !assertCallerCurrent) {
          throw new ToolAuthorizationError("Non-owner assignment requires an admitted agent turn");
        }
        assertCallerCurrent?.("sessions.assignOwner");
        const ownerType = readToolStringParam(params, "ownerType", { required: true });
        const ownerId = readToolStringParam(params, "ownerId", { required: true });
        if (ownerType !== "human" && ownerType !== "agent") {
          throw new ToolInputError("assign_owner requires ownerType and ownerId");
        }
        const { agentId, key, requesterAgentId, requesterSessionKey } = await resolvePatchTarget(
          opts,
          readToolStringParam(params, "sessionKey"),
          gatewayRequest,
        );
        const result = await gatewayRequest<SessionsAssignOwnerResult>({
          method: "sessions.assignOwner",
          params: {
            key,
            ...(parseAgentSessionKey(key) ? {} : { agentId }),
            owner: { type: ownerType, id: ownerId },
          },
          agentToolCaller: { agentId: requesterAgentId, sessionKey: requesterSessionKey },
          ...(assertCallerCurrent ? { assertDispatchCurrent: assertCallerCurrent } : {}),
        });
        return jsonResult({
          status: "updated",
          sessionKey: result.key,
          owner: {
            type: result.owner.actor.type,
            id: result.owner.actor.id,
            ...(result.owner.actor.label ? { label: result.owner.actor.label } : {}),
          },
        });
      }
      // Group catalog is global by contract. The action-level owner gate protects mutations.
      if (action === "group_set") {
        const requestedNames = params.names;
        if (!Array.isArray(requestedNames)) {
          throw new ToolInputError("names required");
        }
        const names = requestedNames.map((name, index) => readGroupName(name, `names[${index}]`));
        return jsonResult(await callGateway("sessions.groups.put", { names }));
      }
      if (action === "group_rename" || action === "group_delete") {
        return jsonResult(
          await callGateway(`sessions.groups.${action === "group_rename" ? "rename" : "delete"}`, {
            name: readGroupName(params.name, "name"),
            ...(action === "group_rename" ? { to: readGroupName(params.to, "to") } : {}),
          }),
        );
      }
      if (action !== "patch") {
        throw new ToolInputError(`Unknown action: ${action}`);
      }

      const values = readSessionsToolPatch(params);
      const inProcessGatewayAvailable =
        opts.hasInProcessGatewayContext?.() ??
        (opts.callGateway ? true : hasInProcessGatewayToolContext());
      if (values.model !== undefined && !inProcessGatewayAvailable) {
        return jsonResult({ status: "forbidden", error: "Model patch needs in-process gateway." });
      }
      const patchGateway: AgentToolGatewayRequestCaller = async (request) =>
        values.model === undefined
          ? await gatewayRequest(request)
          : await withAgentSessionModelPatchOrigin(async () => await gatewayRequest(request));
      if (params.targets !== undefined) {
        return jsonResult(
          await runSessionsToolPatchMany({
            targets: params.targets,
            patch: values,
            resolveTarget: (sessionKey) => resolvePatchTarget(opts, sessionKey, gatewayRequest),
            callGateway: patchGateway,
          }),
        );
      }
      const { agentId, cfg, isRequesterSession, key } = await resolvePatchTarget(
        opts,
        readToolStringParam(params, "sessionKey"),
        gatewayRequest,
      );
      const archived = values.archived;
      const requestedSessionId = readToolStringParam(params, "expectedSessionId");
      const renameSessionId = isRequesterSession
        ? normalizeOptionalString(opts.agentSessionId)
        : requestedSessionId;
      if (
        restrictedRename &&
        (!renameSessionId || (requestedSessionId && requestedSessionId !== renameSessionId))
      ) {
        throw new ToolInputError("Session rename requires the current durable session identity");
      }
      const expectedSessionId = restrictedRename
        ? renameSessionId
        : (requestedSessionId ??
          (typeof archived === "boolean" && isRequesterSession
            ? normalizeOptionalString(opts.agentSessionId)
            : undefined));
      if (typeof archived === "boolean" && !expectedSessionId) {
        throw new ToolInputError("Session lifecycle action requires a durable session identity");
      }
      const lifecycleIdentity = expectedSessionId ? { expectedSessionId } : undefined;
      const patch = { key, ...lifecycleIdentity, ...values };
      let selectedLifecycleRevision: string | null | undefined;
      const controlTarget = () => ({
        cfg,
        agentId,
        key,
        expectedSessionId,
        expectedLifecycleRevision: selectedLifecycleRevision,
        operation: archived === true ? ("archive" as const) : ("restore" as const),
        restricted: true,
      });
      const callSessionPatch = (
        sessionPatch: typeof patch & { agentId?: string },
      ): Promise<SessionsPatchResult> =>
        restrictedRename
          ? patchGateway({
              method: "sessions.patch",
              params: sessionPatch,
              // Even broader non-owner operators use the canonical creator-only guard for rename.
              scopes: ["operator.sessions.write"],
            })
          : controlOnly
            ? callSessionToolControl<SessionsPatchResult>(
                controlTarget(),
                { method: "sessions.patch", params: sessionPatch },
                patchGateway,
              )
            : patchGateway({ method: "sessions.patch", params: sessionPatch });
      const includeResolved = patch.model !== undefined || patch.thinkingLevel !== undefined;
      const agentScope = parseAgentSessionKey(key) ? {} : { agentId };

      if (patch.archived === true && isRequesterSession && key !== "global") {
        if (key !== resolveAgentMainSessionKey({ cfg, agentId })) {
          const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
          const currentEntry = await readSessionEntryReadOnlyInWorker({
            agentId,
            sessionKey: key,
            storePath,
          });
          const released = captureSessionControllerSettlement({
            target: captureSessionTarget({
              storeScope: storePath,
              sessionKey: key,
              incarnation: currentEntry?.sessionId,
              agentId,
            }),
          });

          if (
            currentEntry?.sessionId === lifecycleIdentity?.expectedSessionId &&
            released &&
            lifecycleIdentity
          ) {
            if (controlOnly) {
              const selected = await prepareSessionToolControlTarget(controlTarget());
              selectedLifecycleRevision = selected.lifecycleRevision;
              selected.release();
            }
            const expectedSessionIdentity = lifecycleIdentity;
            const {
              archived: _archived,
              expectedSessionId: _expectedSessionId,
              ...immediatePatch
            } = patch;
            let immediateResult: SessionsPatchResult | undefined;
            if (Object.keys(immediatePatch).length > 1) {
              immediateResult = await callSessionPatch({
                ...immediatePatch,
                ...agentScope,
                ...expectedSessionIdentity,
              });
            }

            // Archive only after the final tool result, transcript, and every
            // admitted owner have settled. Gateway-owned compare-and-swap
            // keeps a reset replacement from being archived between checks.
            // Accepted work retains its source authority, not the request/turn
            // lifetime that must end before the archive can commit.
            const archiveGatewayContext = getInProcessGatewayToolContext();
            void runWithGatewayToolContinuationContext(() =>
              released
                .then(async () => {
                  const archiveTarget = captureSessionTarget({
                    storeScope: storePath,
                    sessionKey: key,
                    incarnation: expectedSessionIdentity.expectedSessionId,
                    agentId,
                  });
                  const archivePatch = {
                    key,
                    ...agentScope,
                    archived: true,
                    ...expectedSessionIdentity,
                  };
                  while (true) {
                    const competingRelease = captureSessionControllerSettlement({
                      target: archiveTarget,
                    });
                    if (competingRelease) {
                      await competingRelease;
                      continue;
                    }

                    try {
                      await (controlOnly
                        ? callSessionPatch(archivePatch)
                        : callGateway("sessions.patch", archivePatch));
                      return;
                    } catch (error) {
                      // A tracked competing turn can delay archival. Untracked
                      // races and transport failures are best effort: warn below.
                      const retryableGatewayFailure =
                        error instanceof GatewayTransportError ||
                        isTransientNetworkError(error) ||
                        (typeof error === "object" &&
                          error !== null &&
                          "retryable" in error &&
                          error.retryable === true);
                      if (!retryableGatewayFailure) {
                        throw error;
                      }
                      const retryAfterRelease = captureSessionControllerSettlement({
                        target: archiveTarget,
                      });
                      if (!retryAfterRelease) {
                        throw error;
                      }
                      await retryAfterRelease;
                    }
                  }
                })
                .catch(async (error: unknown) => {
                  log.warn(`deferred self-archive failed for ${key}: ${formatErrorMessage(error)}`);
                  const source = captureSessionControlAuthority();
                  const target = {
                    agentId,
                    storePath,
                    sessionKey: key,
                    sessionId: expectedSessionIdentity.expectedSessionId,
                  };
                  // The settled model writer no longer owns this accepted outcome.
                  // Keep the retained source and exact session generation at the report commit.
                  const report = await runWithoutOwnedSessionTranscriptWrites(() =>
                    withSessionTranscriptWriteAssertion(
                      target,
                      composeSessionSourceAssertion([source?.assertCurrent], (assertSource) => {
                        assertSource();
                        if (getInProcessGatewayToolContext() !== archiveGatewayContext) {
                          throw new Error("Deferred archive Gateway owner changed");
                        }
                      }),
                      () =>
                        appendSessionTranscriptReport(target, {
                          kind: "custom",
                          customTypes: ["session-archive-failed"],
                          selectReport: () => ({
                            customType: "session-archive-failed",
                            content:
                              "The scheduled session archive could not be confirmed. Check whether this session is archived before trying again.",
                            display: true,
                            excludeFromContext: true,
                            details: { operation: "archive", outcome: "unconfirmed" },
                          }),
                        }),
                    ),
                  );
                  if (!report.ok) {
                    log.warn(
                      `deferred self-archive notice unavailable for ${key}: ${report.error.code}`,
                    );
                  }
                }),
            ).catch((error: unknown) => {
              log.warn(
                `deferred self-archive outcome unavailable for ${key}: ${formatErrorMessage(error)}`,
              );
            });

            recordSessionToolActionFact({
              operation: "archive",
              fact: "scheduled",
              targetAgentId: agentId,
              targetSessionKey: key,
            });

            return jsonResult(
              withBoundedSessionsResolved(
                {
                  status: "scheduled",
                  sessionKey: key,
                  message: "Session will be archived after the current agent run finishes.",
                },
                includeResolved ? immediateResult?.resolved : undefined,
              ),
            );
          }
        }
      }

      const operation =
        archived === true ? "archive" : archived === false ? "restore" : ("patch" as const);
      const result = await runSessionToolActionWithConflictReceipt({
        operation,
        targetAgentId: agentId,
        targetSessionKey: key,
        run: async () => await callSessionPatch({ ...patch, ...agentScope }),
      });
      recordSessionToolActionFact({
        operation,
        fact: "committed",
        targetAgentId: agentId,
        targetSessionKey: key,
      });
      return jsonResult(
        withBoundedSessionsResolved(
          {
            status: "updated",
            sessionKey: key,
            updated: Object.keys(values),
          },
          includeResolved ? result.resolved : undefined,
        ),
      );
    }),
  };
}
