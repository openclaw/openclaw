// Question gateway methods create, inspect, wait for, and resolve transient prompts.
import {
  ErrorCodes,
  errorShape,
  type Question,
  type QuestionRecord,
  type QuestionRequestParams,
  type QuestionResolvedEvent,
  validateQuestionGetParams,
  validateQuestionListParams,
  validateQuestionRequestParams,
  validateQuestionResolveParams,
  validateQuestionWaitAnswerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../../agents/embedded-agent-runner/run-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "../../infra/question-channel-runtime.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  listSecretStoreEntries,
  SecretStoreValidationError,
} from "../../secrets/store/secret-store.js";
import {
  authorizeCurrentOperatorRoleScopes,
  hasOperatorBoundary,
} from "../operator-role-policy.js";
import { canSelectQuestion, usesOwnRunQuestionAccess } from "../question-access.js";
import {
  QuestionManager,
  QuestionManagerError,
  QuestionManagerErrorCodes,
  type QuestionOwnRunAccess,
} from "../question-manager.js";
import { questionShapeError } from "../question-validation.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeOwnSessionMutation,
} from "../session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import {
  authorizeSessionSharing,
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import type { SecretStoreWriteService } from "./secrets.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_QUESTION_TIMEOUT_MS = 15 * 60 * 1_000;

class QuestionRequestValidationError extends Error {}

function managerError(error: unknown, respond: RespondFn): boolean {
  if (!(error instanceof QuestionManagerError)) {
    return false;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, error.message, { details: { reason: error.code } }),
  );
  return true;
}

function questionNotFound(id: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `question '${id}' was not found`, {
    details: { reason: QuestionManagerErrorCodes.NOT_FOUND },
  });
}

function authorizeQuestionRecord(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  question: QuestionRecord;
  access: "read" | "mutate";
  ownRunAccess?: QuestionOwnRunAccess;
}): ReturnType<typeof errorShape> | null {
  if (usesOwnRunQuestionAccess(params.client)) {
    return params.ownRunAccess?.canAccess(params.client, params.cfg)
      ? null
      : questionNotFound(params.question.id);
  }
  if (
    isGatewayAdmin(params.client) ||
    !hasOperatorBoundary(params.client, params.cfg) ||
    !params.question.sessionKey
  ) {
    return null;
  }
  const target = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.question.sessionKey,
    agentId: params.question.agentId,
  });
  const canSeeSession =
    target &&
    (createSessionListEntryFilter({ cfg: params.cfg, client: params.client })?.(
      target.canonicalKey,
      target.entry,
    ) ??
      true);
  if (!target || !canSeeSession) {
    return questionNotFound(params.question.id);
  }
  return params.access === "mutate"
    ? authorizeSessionSharingTarget({ cfg: params.cfg, client: params.client, target })
    : null;
}

function normalizeQuestions(params: QuestionRequestParams): Question[] {
  const error = questionShapeError(params.questions, {
    allowPlainSecretQuestions: false,
    validateUrls: true,
  });
  if (error) {
    throw new QuestionRequestValidationError(error);
  }
  return params.questions.map((question) => {
    const binding = question.secretStore;
    if (binding) {
      const existing = listSecretStoreEntries({ scope: { kind: "team" } }).find(
        (entry) => entry.name === binding.name,
      );
      return {
        ...question,
        // Save the policy shown for consent, never inherit unseen hosts at submission.
        secretStore: {
          ...binding,
          allowedHosts: binding.allowedHosts ?? existing?.allowedHosts ?? [],
        },
        ...(existing
          ? {
              secretStoreExisting: {
                updatedAtMs: existing.updatedAtMs,
                ...(existing.updatedBy ? { updatedBy: existing.updatedBy } : {}),
              },
            }
          : {}),
      };
    }
    return question;
  });
}

/** Creates the lazily loaded question RPC surface for one Gateway lifetime. */
export function createQuestionHandlers(
  manager: QuestionManager,
  storeWriteService: SecretStoreWriteService,
): GatewayRequestHandlers {
  return {
    "question.request": async (options) => {
      const { params, respond, context, client } = options;
      if (!assertValidParams(params, validateQuestionRequestParams, "question.request", respond)) {
        return;
      }
      const authority = readGatewayRequestMutationAuthority(options);
      authority.assertCurrent();
      let request = params as QuestionRequestParams;
      const storeBound = request.questions.some((question) => question.secretStore);
      // Store-bound questions end in a secret-store write on resolve. Without
      // this gate any operator.questions client could mint and self-answer one,
      // bypassing the operator.admin requirement on secrets.store.set.
      if (storeBound && !isGatewayAdmin(client)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "secret store questions require an operator.admin client",
          ),
        );
        return;
      }
      const identity = client?.internal?.agentRuntimeIdentity;
      const validateAuthority = context.validateAgentRuntimeApprovalAuthority;
      if (storeBound && (!identity || !validateAuthority)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "secret store questions require trusted agent runtime authority",
          ),
        );
        return;
      }
      // Capture the admitted identity privately, not the caller's correlation fields.
      // Revalidate this exact claim even if another execution reuses its runId.
      const requester = identity ? structuredClone(identity) : undefined;
      const operatorAuthority = client?.internal?.operatorRunAuthority;
      const ownRun = usesOwnRunQuestionAccess(client);
      let sessionFacts: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
      let ownRunAccess: QuestionOwnRunAccess | undefined;
      let registered = false;
      const isRequesterActive =
        requester && validateAuthority
          ? () => {
              try {
                operatorAuthority?.assertCurrent();
                sessionFacts?.readCurrent(context.getRuntimeConfig());
                return validateAuthority(requester);
              } catch {
                return false;
              }
            }
          : undefined;
      if (requester) {
        request = {
          ...request,
          agentId: requester.agentId,
          sessionKey: requester.sessionKey,
          runId: requester.operationalRunInstance.runId,
        };
      }
      try {
        if (
          ownRun &&
          (!requester ||
            !operatorAuthority ||
            !isRequesterActive ||
            request.questions.some((question) => question.isSecret || question.secretStore))
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.FORBIDDEN,
              "Session-scoped questions require an ordinary question from your own active agent run.",
            ),
          );
          return;
        }
        const requestedSession = request.sessionKey
          ? resolveRequestedSessionAgentId(
              context.getRuntimeConfig(),
              request.sessionKey,
              request.agentId,
            )
          : undefined;
        if (requestedSession && !requestedSession.ok) {
          respond(false, undefined, requestedSession.error);
          return;
        }
        let sessionKey: string | undefined;
        if (ownRun && operatorAuthority && requestedSession?.ok && request.sessionKey) {
          assertAdmittedRunOperatorAuthority(operatorAuthority);
          const profileId = operatorAuthority.profileId;
          try {
            operatorAuthority.assertCurrent();
            sessionFacts = await prepareSessionMutationFacts({
              cfg: context.getRuntimeConfig(),
              agentId: requestedSession.agentId,
              sessionKey: request.sessionKey,
            });
          } catch {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                "Question session authority is no longer available.",
              ),
            );
            return;
          }
          const prepared = sessionFacts;
          const canSelect: QuestionOwnRunAccess["canSelect"] = (recipient) =>
            Boolean(
              recipient &&
              !recipient.invalidated &&
              (recipient.connect.role ?? "operator") === "operator" &&
              !authorizeOwnSessionMutation({
                client: recipient,
                target: null,
                expectedProfileId: profileId,
              }),
            );
          ownRunAccess = {
            canSelect,
            release: prepared.release,
            canAccess: (recipient, cfg) => {
              if (!canSelect(recipient)) {
                return false;
              }
              try {
                if (authorizeCurrentOperatorRoleScopes(recipient, cfg)) {
                  return false;
                }
                const { target } = prepared.readCurrent(cfg);
                return (
                  !authorizeOwnSessionMutation({
                    client: recipient,
                    target,
                    expectedProfileId: profileId,
                  }) &&
                  !authorizeIncognitoSessionTarget({
                    client: recipient,
                    sessionKey: target.canonicalKey,
                    target,
                  })
                );
              } catch {
                return false;
              }
            },
          };
          sessionKey = prepared.readCurrent(context.getRuntimeConfig()).target.canonicalKey;
        } else {
          sessionKey =
            request.sessionKey && requestedSession?.ok
              ? resolveStoredSessionKeyForAgentStore({
                  cfg: context.getRuntimeConfig(),
                  agentId: requestedSession.agentId,
                  sessionKey: request.sessionKey,
                })
              : undefined;
        }
        if (ownRun && !ownRunAccess?.canAccess(client, context.getRuntimeConfig())) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.FORBIDDEN,
              "Session-scoped questions require your own active session.",
            ),
          );
          return;
        }
        if (!ownRun && sessionKey && hasOperatorBoundary(client, context.getRuntimeConfig())) {
          const authorizationError = authorizeSessionSharing({
            cfg: context.getRuntimeConfig(),
            client,
            sessionKey,
            agentId: requestedSession?.ok ? requestedSession.agentId : undefined,
          });
          if (authorizationError) {
            respond(false, undefined, authorizationError);
            return;
          }
        }
        authority.assertCurrent();
        const access = ownRunAccess;
        const questionRecipient = access
          ? (recipient: GatewayClient) =>
              !usesOwnRunQuestionAccess(recipient) ||
              access.canAccess(recipient, context.getRuntimeConfig())
          : undefined;
        const broadcastQuestion = (
          event: "question.requested" | "question.resolved",
          payload: QuestionRecord | QuestionResolvedEvent,
        ) => {
          if (sessionKey && (questionRecipient || context.getRuntimeConfig().gateway?.roles)) {
            context.broadcast(event, payload, {
              sessionKeys: [sessionKey],
              ...(requestedSession?.ok ? { agentId: requestedSession.agentId } : {}),
              ...(questionRecipient ? { questionRecipient } : {}),
            });
          } else {
            context.broadcast(event, payload);
          }
        };
        const record = manager.request({
          ...(request.id ? { id: request.id } : {}),
          questions: normalizeQuestions(request),
          ...(requestedSession?.ok
            ? { agentId: requestedSession.agentId }
            : request.agentId
              ? { agentId: request.agentId }
              : {}),
          ...(sessionKey ? { sessionKey } : {}),
          ...(request.runId ? { runId: request.runId } : {}),
          timeoutMs: request.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
          isRequesterActive,
          ownRunAccess,
          requesterRun: requester?.operationalRunInstance,
          registerHumanInputWait:
            requester && isRequesterActive
              ? (isPending) =>
                  registerActiveEmbeddedRunHumanInputWait(requester.delegatedAuthority, isPending)
              : undefined,
          onResolved: (event) => {
            handleQuestionChannelResolved(event);
            broadcastQuestion("question.resolved", event);
          },
        });
        registered = true;
        handleQuestionChannelRequested(record);
        broadcastQuestion("question.requested", record);
        respond(true, { id: record.id, expiresAtMs: record.expiresAtMs }, undefined);
      } catch (error) {
        if (error instanceof QuestionRequestValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        if (!managerError(error, respond)) {
          if (storeBound) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, "Secret store entry metadata is unavailable."),
            );
            return;
          }
          throw error;
        }
      } finally {
        if (!registered) {
          sessionFacts?.release();
        }
      }
    },
    "question.waitAnswer": async (options) => {
      const { params, respond, client, context } = options;
      if (
        !assertValidParams(params, validateQuestionWaitAnswerParams, "question.waitAnswer", respond)
      ) {
        return;
      }
      const request = params;
      const authority = readGatewayRequestMutationAuthority(options);
      try {
        authority.assertCurrent();
        const question = canSelectQuestion(manager, request.id, client)
          ? manager.get(request.id)
          : null;
        const ownRunAccess = manager.getOwnRunAccess(request.id);
        if (!question) {
          respond(false, undefined, questionNotFound(request.id));
          return;
        }
        let authorizationError = authorizeQuestionRecord({
          cfg: context.getRuntimeConfig(),
          client,
          question,
          access: "read",
          ownRunAccess,
        });
        if (authorizationError) {
          respond(false, undefined, authorizationError);
          return;
        }
        const answer = await manager.waitAnswer(
          request.id,
          request.timeoutMs,
          request.includeResolutionId,
        );
        authority.assertCurrent();
        // Reauthorize the original question's immutable routing, not a getter
        // that could expire/cancel it merely because this observer stopped.
        authorizationError = authorizeQuestionRecord({
          cfg: context.getRuntimeConfig(),
          client,
          question,
          access: "read",
          ownRunAccess,
        });
        if (authorizationError) {
          respond(false, undefined, authorizationError);
          return;
        }
        respond(true, answer, undefined);
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.resolve": async (options) => {
      const { params, respond, client, context } = options;
      if (!assertValidParams(params, validateQuestionResolveParams, "question.resolve", respond)) {
        return;
      }
      const request = params;
      try {
        readGatewayRequestMutationAuthority(options).assertCurrent();
        const question = canSelectQuestion(manager, request.id, client)
          ? manager.get(request.id)
          : null;
        if (!question) {
          respond(false, undefined, questionNotFound(request.id));
          return;
        }
        const authorizationError = authorizeQuestionRecord({
          cfg: context.getRuntimeConfig(),
          client,
          question,
          access: "mutate",
          ownRunAccess: manager.getOwnRunAccess(request.id),
        });
        if (authorizationError) {
          respond(false, undefined, authorizationError);
          return;
        }
        if ("cancel" in request) {
          respond(true, manager.cancel(request.id, request.resolvedBy), undefined);
          return;
        }
        const secretQuestion = question.questions[0];
        const binding = secretQuestion?.secretStore;
        if (!binding) {
          if (request.secretStoreAllowedHosts !== undefined) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "Secret store allowed hosts require a store-bound question.",
              ),
            );
            return;
          }
          respond(
            true,
            manager.resolve(request.id, request.answers, request.resolvedBy, {
              resolutionId: request.resolutionId,
            }),
            undefined,
          );
          return;
        }
        const submittedAnswers = request.answers.answers;
        const values = Object.hasOwn(submittedAnswers, secretQuestion.questionId)
          ? submittedAnswers[secretQuestion.questionId]
          : undefined;
        const value = values?.[0];
        if (
          Object.keys(submittedAnswers).length !== 1 ||
          values?.length !== 1 ||
          value === undefined
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `question '${secretQuestion.questionId}' requires exactly one secret value`,
            ),
          );
          return;
        }
        registerSecretValueForRedaction(value);
        const allowedHosts = request.secretStoreAllowedHosts ?? binding.allowedHosts;
        let saved = false;
        try {
          // Only the synthetic marker enters state, fanout, and waiting agents.
          // The manager validates liveness and settles before refresh can yield.
          const result = manager.resolve(
            request.id,
            { answers: { [secretQuestion.questionId]: ["stored"] } },
            request.resolvedBy,
            {
              resolutionId: request.resolutionId,
              commit: () => {
                storeWriteService.write({
                  name: binding.name,
                  value,
                  kind: "secret",
                  ...(allowedHosts !== undefined ? { allowedHosts } : {}),
                  updatedBy: storeWriteService.resolveUpdatedBy(client),
                });
                saved = true;
              },
            },
          );
          await storeWriteService.reloadReference(binding.name);
          respond(true, result, undefined);
        } catch (error) {
          if (managerError(error, respond)) {
            return;
          }
          respond(
            false,
            undefined,
            errorShape(
              !saved && error instanceof SecretStoreValidationError
                ? ErrorCodes.INVALID_REQUEST
                : ErrorCodes.UNAVAILABLE,
              saved
                ? "Secret store entry was saved, but runtime refresh failed. Resolve provider errors and retry secrets.reload; do not resubmit this answer."
                : error instanceof SecretStoreValidationError
                  ? error.message
                  : "Secret store entry could not be saved.",
            ),
          );
        }
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.get": (options) => {
      const { params, respond, client, context } = options;
      if (!assertValidParams(params, validateQuestionGetParams, "question.get", respond)) {
        return;
      }
      readGatewayRequestMutationAuthority(options).assertCurrent();
      const id = (params as { id: string }).id;
      const question = canSelectQuestion(manager, id, client) ? manager.get(id) : null;
      if (!question) {
        respond(false, undefined, questionNotFound(id));
        return;
      }
      const authorizationError = authorizeQuestionRecord({
        cfg: context.getRuntimeConfig(),
        client,
        question,
        access: "read",
        ownRunAccess: manager.getOwnRunAccess(id),
      });
      if (authorizationError) {
        respond(false, undefined, authorizationError);
        return;
      }
      respond(true, { question }, undefined);
    },
    "question.list": (options) => {
      const { params, respond, client, context } = options;
      if (!assertValidParams(params, validateQuestionListParams, "question.list", respond)) {
        return;
      }
      readGatewayRequestMutationAuthority(options).assertCurrent();
      const cfg = context.getRuntimeConfig();
      const questions = manager
        .list(
          usesOwnRunQuestionAccess(client)
            ? (question) => canSelectQuestion(manager, question.id, client)
            : undefined,
        )
        .filter(
          (question) =>
            !authorizeQuestionRecord({
              cfg,
              client,
              question,
              access: "read",
              ownRunAccess: manager.getOwnRunAccess(question.id),
            }),
        );
      respond(true, { questions }, undefined);
    },
  };
}
