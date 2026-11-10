import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentsCreateParams,
  AgentsCreateResult,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  getRuntimeConfigAppliedHash,
  hashRuntimeConfigValue,
} from "../../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.js";
import { readSessionCreationReceiptInWorker } from "../../config/sessions/session-creation-receipt-read.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import { verifySetupInferenceConfig } from "../../system-agent/setup-inference-turn.js";
import { TEMPLATE_AGENT_OPENING_MESSAGE } from "../../templates/conversation.js";
import { waitForAgentJob } from "../agent-turn/agent-job.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { startSessionCreateDiagnostics } from "../session-create-diagnostics.js";
import { createGatewaySession } from "../session-create-service.js";
import type { CreatedGatewaySession } from "../session-create-service.types.js";
import {
  checkpointSessionCreateTarget,
  finalizeSessionCreateTarget,
} from "../session-create-target.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { createSystemAgentGatewayRuntime } from "./system-agent-execution.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type PreparedAgentOnboarding = {
  expectedConfigHash: string | null;
  assertCurrent: () => void;
};

/** Verify the primary route before the creation owner writes any agent state. */
export async function prepareAgentOnboarding(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  params: AgentsCreateParams,
): Promise<PreparedAgentOnboarding> {
  const authority = readGatewayRequestMutationAuthority(options);
  const runtimeConfig = options.context.getRuntimeConfig();
  const appliedHash = getRuntimeConfigAppliedHash();
  const assertCurrent = () => {
    authority.assertCurrent();
    if (
      appliedHash === null ||
      !options.context.isConfigReloadSettled() ||
      options.context.getRuntimeConfig() !== runtimeConfig ||
      getRuntimeConfigAppliedHash() !== appliedHash
    ) {
      throw new Error(
        "Gateway settings changed or are not active yet. Wait for application to finish, then retry creation.",
      );
    }
  };
  assertCurrent();
  const snapshot = await readConfigFileSnapshot();
  assertCurrent();
  if (
    !snapshot.exists ||
    !snapshot.valid ||
    hashRuntimeConfigValue(snapshot.sourceConfig) !== appliedHash
  ) {
    throw new Error(
      "Gateway settings are saved but not active yet. Wait for application to finish, then retry creation.",
    );
  }
  // Match creation's prospective model/workspace without publishing its roster entry.
  const candidate = applyAgentConfig(runtimeConfig, {
    agentId,
    ...(params.model ? { model: params.model } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
  });
  const verification = await verifySetupInferenceConfig({
    config: candidate,
    agentId,
    modelTarget: "primary",
    requireExecutionOwner: false,
    runtime: createSystemAgentGatewayRuntime(),
    assertSourceCurrent: assertCurrent,
    signal: options.signal,
  });
  assertCurrent();
  if (!verification.ok) {
    throw new Error(verification.error);
  }
  return {
    expectedConfigHash: snapshot.hash ?? null,
    assertCurrent,
  };
}

/** Creation has committed; session preparation failure must retain that agent's receipt. */
export async function completeAgentOnboarding(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  prePublication?: {
    config: OpenClawConfig;
    commandSource?: "cli";
    initializationPending?: true;
    templateInitialization?: SessionEntry["templateInitialization"];
    recover?: true;
  },
): Promise<
  NonNullable<AgentsCreateResult["onboarding"]> & {
    rollback?: (() => Promise<void>) & {
      assertCurrent?: () => Promise<void>;
      complete?: () => Promise<void>;
      checkpoint?: (
        initialization: NonNullable<SessionEntry["templateInitialization"]>,
      ) => Promise<void>;
    };
    preparationUncertain?: true;
  }
> {
  using diagnostics = startSessionCreateDiagnostics();
  const cfg = prePublication?.config ?? options.context.getRuntimeConfig();
  const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const preparation: { committed?: CreatedGatewaySession } = {};
  const digest = randomUUID();
  const operation = prePublication
    ? { digest, fingerprint: digest, authorization: { role: null, scopes: [] } }
    : undefined;
  try {
    const authority = readGatewayRequestMutationAuthority(options);
    if (prePublication?.recover) {
      const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
      const entry = await readSessionEntryReadOnlyInWorker(
        { agentId, storePath, sessionKey },
        authority.assertCurrent,
      );
      if (
        !entry?.initializationPending ||
        !entry.templateInitialization ||
        !isDeepStrictEqual(entry.templateInitialization, prePublication.templateInitialization)
      ) {
        throw new Error("The retained Template initialization incarnation changed");
      }
      preparation.committed = { agentId, key: sessionKey, storePath, entry, isNew: false };
    } else {
      const created = await createGatewaySession({
        cfg,
        ...(prePublication?.initializationPending ? { deferInitialization: true as const } : {}),
        ...(operation ? { creationOperation: operation } : {}),
        ...(prePublication?.templateInitialization
          ? { templateInitialization: prePublication.templateInitialization }
          : {}),
        // Add owns the prospective config and revalidates it before publishing. The
        // session owner prepares only this private target; it never activates a roster.
        ...(!prePublication ? { getCurrentConfig: options.context.getRuntimeConfig } : {}),
        agentId,
        key: sessionKey,
        commandSource: prePublication?.commandSource ?? "webchat",
        creation: resolveOperatorSessionCreation(options.client),
        requestingOperatorScopes: options.client?.connect.scopes,
        requestingOperatorProfileId: options.client?.authenticatedUserProfile?.profileId,
        operatorRoleActor: resolveGatewayOperatorRoleActor(options.client),
        commitGuard: authority.assertCurrent,
        onPhase: diagnostics?.mark,
        onCreatedSessionCommitted: (session) => {
          preparation.committed = session;
          options.sessionMutationAuthorization?.recordCreatedSession?.({
            agentId,
            sessionKey,
            storePath: session.storePath,
            sessionId: session.entry.sessionId,
            entry: session.entry,
            lifecycleRevision: session.entry.lifecycleRevision,
          });
        },
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      if (!prePublication) {
        emitSessionsChanged(options.context, { agentId, sessionKey, reason: "created" });
        return { sessionKey, status: "completed" };
      }
    }
    const session = preparation.committed;
    if (!session || (!session.isNew && !prePublication?.recover)) {
      throw new Error("Template Add did not prepare a new ordinary session");
    }
    return {
      sessionKey,
      status: "completed",
      // Cleanup owns only this unpublished incarnation, not a saved approval. Once
      // Add publishes the agent, it discards this cleanup and keeps the session.
      rollback: Object.assign(
        () => (prePublication.recover ? Promise.resolve() : rollbackPreparedAgentSession(session)),
        prePublication.initializationPending
          ? {
              assertCurrent: async () => {
                authority.assertCurrent();
                const current = await readSessionEntryReadOnlyInWorker(
                  { agentId, storePath: session.storePath, sessionKey },
                  authority.assertCurrent,
                );
                if (
                  !isDeepStrictEqual(current, session.entry) ||
                  current?.initializationPending !== true
                ) {
                  throw new Error(
                    "The pending ordinary session changed before Template initialization",
                  );
                }
              },
              checkpoint: async (
                initialization: NonNullable<SessionEntry["templateInitialization"]>,
              ) => {
                session.entry = await checkpointSessionCreateTarget(
                  session,
                  session.entry,
                  initialization,
                  authority.assertCurrent,
                );
              },
              complete: async () => {
                await finalizeSessionCreateTarget(session, session.entry, authority.assertCurrent);
                emitSessionsChanged(options.context, { agentId, sessionKey, reason: "created" });
              },
            }
          : {},
      ),
    };
  } catch (error) {
    if (operation && !prePublication?.recover) {
      try {
        let session = preparation.committed;
        if (!session) {
          const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
          // This operation's receipt is committed atomically with the row. Reconcile
          // the original destination; absence never settles an unknown writer outcome.
          const stored = await readSessionCreationReceiptInWorker(
            { agentId, storePath },
            operation.digest,
            () => {},
          );
          if (stored) {
            if (
              !stored.entry ||
              stored.receipt.sessionKey !== sessionKey ||
              stored.entry.sessionId !== stored.receipt.sessionId ||
              (stored.entry.lifecycleRevision ?? null) !== stored.receipt.lifecycleRevision
            ) {
              throw new Error("The prepared session incarnation changed before reconciliation", {
                cause: error,
              });
            }
            session = { agentId, key: sessionKey, storePath, entry: stored.entry, isNew: true };
          } else if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
        }
        if (session) {
          await rollbackPreparedAgentSession(session);
        }
      } catch (reconcileError) {
        return {
          sessionKey,
          status: "error",
          preparationUncertain: true,
          error: formatErrorMessage(
            new AggregateError(
              [error, reconcileError],
              "Ordinary session preparation could not be reconciled; keep its workspace for inspection",
            ),
          ),
        };
      }
    }
    return { sessionKey, status: "error", error: formatErrorMessage(error) };
  }
}

async function rollbackPreparedAgentSession(session: CreatedGatewaySession): Promise<void> {
  const removed = await deleteSessionEntryLifecycle({
    agentId: session.agentId,
    storePath: session.storePath,
    target: { canonicalKey: session.key, storeKeys: [session.key] },
    expectedSessionId: session.entry.sessionId,
    expectedLifecycleRevision: session.entry.lifecycleRevision,
    expectedUpdatedAt: session.entry.updatedAt,
    archiveTranscript: false,
    deleteTranscriptWithoutArchive: true,
    requireWriteSuccess: true,
  });
  if (!removed.deleted) {
    throw new Error("The prepared ordinary session changed; cleanup left it intact");
  }
}

/** Start the first real agent turn after the create receipt has reached the UI. */
export async function startAgentOnboardingConversation(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  sessionKey: string,
  opening: "new-agent" | "template" = "new-agent",
): Promise<void> {
  const releaseAuthorization = options.sessionMutationAuthorization?.retain?.();
  using _ = { [Symbol.dispose]: () => releaseAuthorization?.() };
  let response: Parameters<GatewayRequestHandlerOptions["respond"]> | undefined;
  const runId = `agents.create:${agentId}:${opening === "template" ? "template-greeting" : "onboarding-question"}`;
  try {
    await runOutsideAsyncWorkScope(() =>
      handleTrustedInternalChatSend(
        {
          ...options,
          req: { ...options.req, method: "chat.send" },
          params: {
            sessionKey,
            agentId,
            message:
              opening === "template"
                ? TEMPLATE_AGENT_OPENING_MESSAGE
                : [
                    "Ask the user in plain text: What role would you like me to take on?",
                    "Offer these four single-agent roles: Chief of staff (coordinates work and priorities), Researcher (finds and summarizes evidence), Writer (turns notes and sources into drafts), and Reviewer (checks work against requirements). Invite the user to describe a different role if they prefer. Do not offer a team. Ask only about the role in this opening turn; do not ask for their goal or mention a later follow-up yet. End the message there and wait for their reply.",
                    "After the user replies, ask one open-ended follow-up that invites a little detail about the specific thing they want to achieve. Tailor it to their answer, but do not provide another list or hard-code the follow-up wording. Then continue normally after they answer.",
                    "This agent already exists. Do not propose creating an agent or ask the user to approve its creation.",
                  ].join("\n\n"),
            idempotencyKey: runId,
            deliver: false,
            suppressCommandInterpretation: true,
            systemInputProvenance: {
              kind: "internal_system",
              sourceTool: "agents_create_onboarding",
            },
          },
          respond: (...args) => {
            response ??= args;
          },
        },
        undefined,
        {
          transcript: { display: false },
          toolsAllow: [],
          ...(opening === "template" ? { deferWorkspaceBootstrap: true as const } : {}),
        },
      ),
    );
    if (response && !response[0]) {
      throw new Error(formatErrorMessage(response[2]));
    }
    if (opening === "template") {
      // Admission is not model output. The shared installer must not finish
      // deferrable setup before this ordinary chat owner publishes its greeting.
      const terminal = await waitForAgentJob({ runId, source: "chat", timeoutMs: 120_000 });
      if (terminal?.status !== "ok" || terminal.terminalReply?.disposition !== "visible") {
        throw new Error(
          `Template opening did not produce a visible greeting: ${terminal?.error ?? terminal?.status ?? "timed out waiting for chat completion"}. The agent and conversation were kept.`,
        );
      }
    }
  } catch (error) {
    if (opening === "template") {
      throw error;
    }
    options.context.logGateway.warn(
      `could not start onboarding for agent ${agentId}: ${formatErrorMessage(error)}`,
    );
  }
}
