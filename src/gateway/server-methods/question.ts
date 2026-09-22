// Question gateway methods create, inspect, wait for, and resolve transient prompts.
import {
  ErrorCodes,
  errorShape,
  type Question,
  type QuestionRequestParams,
  type QuestionRecord,
  type QuestionResolvedEvent,
  validateQuestionGetParams,
  validateQuestionListParams,
  validateQuestionRequestParams,
  validateQuestionResolveParams,
  validateQuestionWaitAnswerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../../agents/embedded-agent-runner/run-state.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "../../infra/question-channel-runtime.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  listSecretStoreEntries,
  SecretStoreValidationError,
} from "../../secrets/store/secret-store.js";
import { authorizeGatewaySessionCreation, hasOperatorBoundary } from "../operator-role-policy.js";
import { canSelectQuestion, usesOwnRunQuestionAccess } from "../question-access.js";
import {
  QuestionManager,
  QuestionManagerError,
  type QuestionObservation,
} from "../question-manager.js";
import {
  withQuestionSessionAccess,
  withPreparedQuestionSessions,
  type PreparedQuestionSession,
  questionNotFound,
  prepareQuestionAuthorization,
  questionBroadcastOptions,
} from "../question-session-access.js";
import type { QuestionSessionAccess } from "../question-session-access.types.js";
import { questionShapeError } from "../question-validation.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import type { SecretStoreWriteService } from "./secrets.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
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
      let request = params as QuestionRequestParams;
      const storeBound = request.questions.some((question) => question.secretStore);
      const authority = readGatewayRequestMutationAuthority(options);
      authority.assertCurrent();
      const narrow = usesOwnRunQuestionAccess(client);
      let sessionAccess: QuestionSessionAccess | undefined;
      let accepted = false;
      const requiresSharing = () =>
        !isGatewayAdmin(client) && hasOperatorBoundary(client, context.getRuntimeConfig());
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
      if ((storeBound || narrow) && (!identity || !validateAuthority)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            storeBound
              ? "secret store questions require trusted agent runtime authority"
              : "question creation requires trusted agent runtime authority",
          ),
        );
        return;
      }
      // Capture the admitted identity privately, not the caller's correlation fields.
      // Revalidate this exact claim even if another execution reuses its runId.
      const requester = identity ? structuredClone(identity) : undefined;
      const operatorAuthority = client?.internal?.operatorRunAuthority;
      const isRequesterActive =
        requester && validateAuthority
          ? () => {
              try {
                operatorAuthority?.assertCurrent();
                sessionAccess?.assertSourceCurrent();
                return validateAuthority(requester);
              } catch {
                return false;
              }
            }
          : undefined;
      if (
        narrow &&
        (!operatorAuthority ||
          storeBound ||
          request.questions.some((question) => question.isSecret) ||
          isRequesterActive?.() !== true)
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Session-scoped questions require an ordinary question and a live agent requester.",
          ),
        );
        return;
      }
      if (requester) {
        request = {
          ...request,
          agentId: requester.agentId,
          sessionKey: requester.sessionKey,
          runId: requester.operationalRunInstance.runId,
        };
      }
      try {
        if (narrow && operatorAuthority) {
          assertAdmittedRunOperatorAuthority(operatorAuthority);
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
        if (narrow && requestedSession?.ok) {
          // Starting a prompt retains the admitted producer's agent ceiling.
          const agentError = authorizeGatewaySessionCreation({
            cfg: context.getRuntimeConfig(),
            client,
            agentId: requestedSession.agentId,
          });
          if (agentError) {
            respond(false, undefined, agentError);
            return;
          }
        }
        const sessionKey =
          request.sessionKey && requestedSession?.ok
            ? resolveStoredSessionKeyForAgentStore({
                cfg: context.getRuntimeConfig(),
                agentId: requestedSession.agentId,
                sessionKey: request.sessionKey,
              })
            : undefined;
        const create = (prepared?: PreparedQuestionSession) => {
          if (sessionKey && requiresSharing()) {
            const authorizationError = prepared?.authorizeMutation(client);
            if (!prepared?.target || authorizationError) {
              respond(
                false,
                undefined,
                authorizationError ?? errorShape(ErrorCodes.FORBIDDEN, "Session is unavailable."),
              );
              return;
            }
          }
          if (narrow) {
            authority.assertCurrent();
            if (!sessionAccess || !prepared?.canAccess(client, "mutate", true, sessionAccess)) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.FORBIDDEN,
                  "Session-scoped questions require your own materialized ordinary session.",
                ),
              );
              return;
            }
          }
          const broadcastQuestion = (
            event: string,
            payload: unknown,
            observation: QuestionObservation | null,
            current: PreparedQuestionSession | undefined,
            expectedRecord?: QuestionRecord,
          ) => {
            const scoped =
              sessionKey && context.getRuntimeConfig().gateway?.roles
                ? {
                    sessionKeys: [sessionKey],
                    ...(requestedSession?.ok ? { agentId: requestedSession.agentId } : {}),
                  }
                : undefined;
            let publishing = true;
            const retained = questionBroadcastOptions({
              observation,
              prepared: current,
              expectedRecord,
              cfg: context.getRuntimeConfig(),
              isPublishing: () => publishing,
            });
            try {
              if (scoped || retained) {
                context.broadcast(event, payload, { ...scoped, ...retained });
              } else {
                context.broadcast(event, payload);
              }
            } finally {
              publishing = false;
            }
          };
          // Preparation yielded; every caller must still own this initial mutation.
          authority.assertCurrent();
          // The manager awaits returned promises while its public callback type stays void.
          const managerRequest = {
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
            sessionAccess,
            requesterRun: requester?.operationalRunInstance,
            registerHumanInputWait:
              requester && isRequesterActive
                ? (isPending: () => boolean) =>
                    registerActiveEmbeddedRunHumanInputWait(requester.delegatedAuthority, isPending)
                : undefined,
            onResolved: async (event: QuestionResolvedEvent, observation: QuestionObservation) => {
              handleQuestionChannelResolved(event);
              let consumed = false;
              try {
                await withPreparedQuestionSessions(
                  options,
                  [
                    {
                      ...observation.record,
                      sessionAccess: observation.sessionAccess,
                    },
                  ],
                  ([current]) => {
                    consumed = true;
                    if (!observation.isCurrent()) {
                      return;
                    }
                    broadcastQuestion("question.resolved", event, observation, current);
                  },
                  {
                    assertCurrent: () => {
                      if (!observation.isCurrent()) {
                        throw new Error("Question publication owner retired");
                      }
                    },
                  },
                );
              } catch (error) {
                if (consumed || !observation.isCurrent()) {
                  throw error;
                }
                // A failed optional read grants no narrow access. Publish only to
                // recipients the sharing owner admits with unknown session facts.
                broadcastQuestion("question.resolved", event, observation, undefined);
              }
            },
          };
          const record = manager.request(managerRequest);
          accepted = true;
          handleQuestionChannelRequested(record);
          broadcastQuestion(
            "question.requested",
            record,
            manager.observe(record.id, record),
            prepared,
            record,
          );
          respond(true, { id: record.id, expiresAtMs: record.expiresAtMs }, undefined);
        };
        if (sessionKey && requestedSession?.ok) {
          let consumed = false;
          try {
            await withQuestionSessionAccess(
              options,
              sessionKey,
              requestedSession.agentId,
              (access, prepared) => {
                consumed = true;
                sessionAccess = request.questions.some(
                  (question) => question.isSecret || question.secretStore,
                )
                  ? undefined
                  : access;
                try {
                  return create(prepared);
                } finally {
                  if (!sessionAccess) {
                    access?.release();
                  }
                }
              },
              {
                assertCurrent: authority.assertCurrent,
                includeMembers: !narrow && requiresSharing(),
              },
            );
          } catch (error) {
            // Broad/system workflows do not acquire narrow grants when optional facts fail.
            // A required sharing check or a started mutation cannot use this outcome.
            if (consumed || narrow || requiresSharing()) {
              throw error;
            }
            create();
          }
        } else {
          create();
        }
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
        if (!accepted) {
          sessionAccess?.release();
        }
      }
    },
    "question.waitAnswer": async (options) => {
      const { params, respond } = options;
      if (
        !assertValidParams(params, validateQuestionWaitAnswerParams, "question.waitAnswer", respond)
      ) {
        return;
      }
      const request = params;
      try {
        readGatewayRequestMutationAuthority(options).assertCurrent();
        const question = canSelectQuestion(manager, request.id, options.client)
          ? manager.get(request.id)
          : null;
        if (!question) {
          respond(false, undefined, questionNotFound(request.id));
          return;
        }
        const observation = question ? manager.observe(request.id, question) : null;
        const authorize = prepareQuestionAuthorization(options, observation, request.id, "read");
        const target = authorize.target;
        const waiting = await withPreparedQuestionSessions(
          options,
          [target],
          ([prepared]) => {
            const error = authorize.authorize(prepared);
            if (error) {
              respond(false, undefined, error);
              return undefined;
            }
            // Register without yielding between final authorization and the exact-entry waiter.
            return {
              answer: manager.waitAnswer(
                request.id,
                request.timeoutMs,
                request.includeResolutionId,
              ),
            };
          },
          { assertCurrent: authorize.assertCurrent },
        );
        if (!waiting) {
          return;
        }
        const answer = await waiting.answer;
        await withPreparedQuestionSessions(
          options,
          [target],
          ([prepared]) => {
            const error = authorize.authorize(prepared);
            if (error) {
              respond(false, undefined, error);
              return;
            }
            respond(true, answer, undefined);
          },
          { assertCurrent: authorize.assertCurrent },
        );
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.resolve": async (options) => {
      const { params, respond, client } = options;
      if (!assertValidParams(params, validateQuestionResolveParams, "question.resolve", respond)) {
        return;
      }
      const request = params;
      try {
        readGatewayRequestMutationAuthority(options).assertCurrent();
        const question = canSelectQuestion(manager, request.id, options.client)
          ? manager.get(request.id)
          : null;
        if (!question) {
          respond(false, undefined, questionNotFound(request.id));
          return;
        }
        const observation = question ? manager.observe(request.id, question) : null;
        const authorize = prepareQuestionAuthorization(options, observation, request.id, "mutate");
        let reload: { name: string; result: ReturnType<QuestionManager["resolve"]> } | undefined;
        await withPreparedQuestionSessions(
          options,
          [authorize.target],
          ([prepared]) => {
            const authorizationError = authorize.authorize(prepared);
            if (authorizationError) {
              respond(false, undefined, authorizationError);
              return;
            }
            if ("cancel" in request) {
              respond(true, manager.cancel(request.id, request.resolvedBy), undefined);
              return;
            }
            const secretQuestion = question?.questions[0];
            const binding = secretQuestion?.secretStore;
            if (!binding || !question) {
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
              reload = { name: binding.name, result };
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
          },
          {
            assertCurrent: authorize.assertCurrent,
            includeMembers:
              !readGatewayRequestMutationAuthority(options).sessionScope &&
              hasOperatorBoundary(client, options.context.getRuntimeConfig()),
          },
        );
        if (reload) {
          try {
            await storeWriteService.reloadReference(reload.name);
            respond(true, reload.result, undefined);
          } catch {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                "Secret store entry was saved, but runtime refresh failed. Resolve provider errors and retry secrets.reload; do not resubmit this answer.",
              ),
            );
          }
        }
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.get": async (options) => {
      const { params, respond } = options;
      if (!assertValidParams(params, validateQuestionGetParams, "question.get", respond)) {
        return;
      }
      const id = (params as { id: string }).id;
      readGatewayRequestMutationAuthority(options).assertCurrent();
      const question = canSelectQuestion(manager, id, options.client) ? manager.get(id) : null;
      if (!question) {
        respond(false, undefined, questionNotFound(id));
        return;
      }
      const observation = manager.observe(id, question);
      const authorize = prepareQuestionAuthorization(options, observation, id, "read");
      await withPreparedQuestionSessions(
        options,
        [authorize.target],
        ([prepared]) => {
          const error = authorize.authorize(prepared);
          if (error) {
            respond(false, undefined, error);
            return;
          }
          respond(true, { question: observation!.record }, undefined);
        },
        { assertCurrent: authorize.assertCurrent },
      ).catch((error: unknown) => {
        if (!managerError(error, respond)) {
          throw error;
        }
      });
    },
    "question.list": async (options) => {
      const { params, respond } = options;
      if (!assertValidParams(params, validateQuestionListParams, "question.list", respond)) {
        return;
      }
      readGatewayRequestMutationAuthority(options).assertCurrent();
      const records = manager
        .list(
          usesOwnRunQuestionAccess(options.client)
            ? (question) => canSelectQuestion(manager, question.id, options.client)
            : undefined,
        )
        .map((question) => {
          const observation = manager.observe(question.id, question);
          return {
            question,
            observation,
            authorize: prepareQuestionAuthorization(options, observation, question.id, "read"),
          };
        });
      await withPreparedQuestionSessions(
        options,
        records.map(({ authorize }) => authorize.target),
        (prepared) => {
          const questions = records.flatMap(({ question, observation, authorize }, index) =>
            observation?.record === question &&
            question.status === "pending" &&
            !authorize.authorize(prepared[index])
              ? [question]
              : [],
          );
          respond(true, { questions }, undefined);
        },
        { assertCurrent: readGatewayRequestMutationAuthority(options).assertCurrent },
      );
    },
  };
}
