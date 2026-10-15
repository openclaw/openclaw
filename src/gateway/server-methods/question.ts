import {
  ErrorCodes,
  errorShape,
  type Question,
  type QuestionRequestParams,
  type QuestionRecord,
  validateQuestionRequestParams,
  validateQuestionResolveParams,
  validateQuestionWaitAnswerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../../agents/embedded-agent-runner/run-state.js";
import type { DurableQuestion } from "../../config/sessions/session-questions.types.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import { handleQuestionChannelRequested } from "../../infra/question-channel-runtime.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  listSecretStoreEntries,
  SecretStoreValidationError,
} from "../../secrets/store/secret-store.js";
import { installDurableQuestion } from "../durable-question-runtime.js";
import { authorizeGatewaySessionCreation, hasOperatorBoundary } from "../operator-role-policy.js";
import { usesOwnRunQuestionAccess } from "../question-access.js";
import { QuestionManager, type QuestionObservation } from "../question-manager.js";
import type { QuestionRegistrationReservation } from "../question-registration-reservations.js";
import {
  withQuestionSessionAccess,
  withPreparedQuestionSessions,
  type PreparedQuestionSession,
  prepareQuestionCommitAuthority,
  questionBroadcastOptions,
} from "../question-session-access.js";
import type { QuestionSessionAccess } from "../question-session-access.types.js";
import { createDurableQuestionSessionAccess } from "../question-session-durable-access.js";
import { questionShapeError } from "../question-validation.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import {
  registerDurableQuestion,
  retainUnpublishedDurableQuestion,
  durableQuestionPublication,
} from "./question.durable-registration.js";
import { managerError, QuestionRequestValidationError } from "./question.errors.js";
import {
  createQuestionReadHandlers,
  prepareSelectedQuestion,
  waitForQuestionRecovery,
} from "./question.read-handlers.js";
import { createTransientQuestionPublication } from "./question.transient-publication.js";
import type { SecretStoreWriteService } from "./secrets.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_QUESTION_TIMEOUT_MS = 15 * 60 * 1_000;

async function normalizeQuestions(
  params: QuestionRequestParams,
  assertCurrent: () => void,
): Promise<Question[]> {
  const error = questionShapeError(params.questions, {
    allowPlainSecretQuestions: false,
    validateUrls: true,
  });
  if (error) {
    throw new QuestionRequestValidationError(error);
  }
  const entries = params.questions.some((question) => question.secretStore)
    ? await listSecretStoreEntries({ scope: { kind: "team" }, assertCurrent })
    : [];
  assertCurrent();
  return params.questions.map((question) => {
    const binding = question.secretStore;
    if (binding) {
      const existing = entries.find((entry) => entry.name === binding.name);
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
  scheduler: GatewayScheduler,
  durable?: {
    onContinuationOwed: (question: DurableQuestion) => void;
    waitForRecovery?: () => Promise<void>;
  },
): GatewayRequestHandlers {
  return {
    "question.request": async (options) => {
      const { params, respond, context, client } = options;
      if (!assertValidParams(params, validateQuestionRequestParams, "question.request", respond)) {
        return;
      }
      let request = params;
      const storeBound = request.questions.some((question) => question.secretStore);
      const authority = readGatewayRequestMutationAuthority(options);
      authority.assertCurrent();
      const narrow = usesOwnRunQuestionAccess(client);
      let sessionAccess: QuestionSessionAccess | undefined;
      let accepted = false;
      let durableCommitted: DurableQuestion | undefined;
      let registrationReservation: QuestionRegistrationReservation | undefined;
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
        // Caller-selected IDs share the recovered namespace across every agent store.
        if (
          request.id &&
          durable?.waitForRecovery &&
          !(await waitForQuestionRecovery(options, durable.waitForRecovery))
        ) {
          return;
        }
        const questions = await normalizeQuestions(request, authority.assertCurrent);
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
            if (!sessionAccess || !prepared?.canAccess(client, true, sessionAccess)) {
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
            questions,
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
            onResolved: durableCommitted
              ? durableQuestionPublication(context)
              : createTransientQuestionPublication(options, (event, observation, current) =>
                  broadcastQuestion("question.resolved", event, observation, current),
                ),
          };
          let record: QuestionRecord;
          if (durableCommitted && durable) {
            installDurableQuestion(
              manager,
              durableCommitted,
              durable.onContinuationOwed,
              managerRequest,
              registrationReservation,
            );
            record = manager.observe(durableCommitted.record.id)?.record ?? durableCommitted.record;
          } else {
            record = manager.request(managerRequest);
          }
          accepted = true;
          if (!durableCommitted || durableCommitted.record.status === "pending") {
            handleQuestionChannelRequested(record, scheduler);
            broadcastQuestion(
              "question.requested",
              record,
              manager.observe(record.id, record),
              prepared,
              record,
            );
          }
          respond(
            true,
            {
              id: record.id,
              expiresAtMs: record.expiresAtMs,
              ...(request.durable
                ? {
                    durable: Boolean(durableCommitted),
                    ...(durableCommitted ? { status: durableCommitted.record.status } : {}),
                  }
                : {}),
            },
            undefined,
          );
        };
        const recoverableSource =
          operatorAuthority?.recoverySnapshot || operatorAuthority?.channelRecoveryReference;
        if (request.durable && recoverableSource) {
          if (
            !durable ||
            !requester ||
            !sessionKey ||
            !requestedSession?.ok ||
            questions.some(
              (question) =>
                question.isSecret ||
                question.secretStore ||
                question.presentation ||
                question.resource,
            )
          ) {
            throw new QuestionRequestValidationError(
              "Durable custody requires an ordinary native ask_user question in an existing session.",
            );
          }
          registrationReservation = manager.reserveRegistration(request.id);
          durableCommitted = await registerDurableQuestion({
            options,
            request,
            questions,
            sessionKey,
            agentId: requestedSession.agentId,
            narrow,
            requiresSharing,
            scheduler,
            defaultTimeoutMs: DEFAULT_QUESTION_TIMEOUT_MS,
            assertGatewayCurrent: manager.captureCustodyCurrent(),
            reservation: registrationReservation,
          });
          sessionAccess = createDurableQuestionSessionAccess(durableCommitted.sessionBinding);
          await withPreparedQuestionSessions(
            options,
            [{ ...durableCommitted.record, sessionAccess }],
            ([prepared]) => create(prepared),
            {
              assertCurrent: authority.assertCurrent,
              includeMembers: !narrow && requiresSharing(),
            },
          );
        } else if (sessionKey && requestedSession?.ok) {
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
        try {
          if (!accepted) {
            sessionAccess?.release();
            if (durableCommitted && durable) {
              retainUnpublishedDurableQuestion(
                manager,
                durableCommitted,
                durable.onContinuationOwed,
                context,
                registrationReservation,
              );
            }
          }
        } finally {
          registrationReservation?.release();
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
        const selection = prepareSelectedQuestion(
          manager,
          options,
          request.id,
          "read",
          durable?.waitForRecovery,
        );
        const selected = selection instanceof Promise ? await selection : selection;
        if (!selected) {
          return;
        }
        const waiting = await selected.withCurrent(() => ({
          // Register without yielding between final authorization and the exact-entry waiter.
          answer: manager.waitAnswer(request.id, request.timeoutMs, request.includeResolutionId),
        }));
        if (!waiting) {
          return;
        }
        const answer = await waiting.answer;
        await selected.withCurrent(() => {
          respond(true, answer, undefined);
        });
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
        const selection = prepareSelectedQuestion(
          manager,
          options,
          request.id,
          "mutate",
          durable?.waitForRecovery,
        );
        const selected = selection instanceof Promise ? await selection : selection;
        if (!selected) {
          return;
        }
        const { question, observation, authorize } = selected;
        if (manager.hasDurableCustody(request.id)) {
          const commitAuthority = await selected.prepareCommitAuthority();
          try {
            const outcome =
              "cancel" in request
                ? { status: "cancelled" as const, resolvedBy: request.resolvedBy }
                : {
                    status: "answered" as const,
                    answers: request.answers,
                    resolvedBy: request.resolvedBy,
                    resolutionId: request.resolutionId,
                  };
            const result = await manager.settleDurable(
              request.id,
              outcome,
              commitAuthority.assertCurrent,
            );
            commitAuthority.assertCurrent();
            if (result.status === "expired") {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  "The question expired before this answer was committed.",
                  {
                    details: { reason: "QUESTION_ALREADY_TERMINAL", status: "expired" },
                  },
                ),
              );
            } else {
              respond(true, result, undefined);
            }
          } finally {
            commitAuthority.release();
          }
          return;
        }
        let reload: { name: string; result: ReturnType<QuestionManager["resolve"]> } | undefined;
        let save: Promise<void> | undefined;
        await selected.withCurrent(
          () => {
            if ("cancel" in request) {
              authorize.assertCurrent();
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
              authorize.assertCurrent();
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
            save = (async () => {
              let saved = false;
              let authority: Awaited<ReturnType<typeof prepareQuestionCommitAuthority>> | undefined;
              try {
                const currentAuthority = await prepareQuestionCommitAuthority(
                  options,
                  observation,
                  request.id,
                );
                authority = currentAuthority;
                // Only the synthetic marker enters state, fanout, and waiting agents.
                const result = await manager.resolveWithCommit(
                  request.id,
                  { answers: { [secretQuestion.questionId]: ["stored"] } },
                  request.resolvedBy,
                  {
                    resolutionId: request.resolutionId,
                    commit: async (assertQuestionCurrent) => {
                      await storeWriteService.write({
                        name: binding.name,
                        value,
                        kind: "secret",
                        ...(allowedHosts !== undefined ? { allowedHosts } : {}),
                        updatedBy: storeWriteService.resolveUpdatedBy(client),
                        assertCurrent: () => {
                          currentAuthority.assertCurrent();
                          assertQuestionCurrent();
                        },
                      });
                      saved = true;
                    },
                  },
                );
                currentAuthority.assertCurrent();
                reload = { name: binding.name, result };
              } catch (error) {
                if (!saved && managerError(error, respond)) {
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
              } finally {
                authority?.release();
              }
            })();
          },
          !readGatewayRequestMutationAuthority(options).sessionScope &&
            hasOperatorBoundary(client, options.context.getRuntimeConfig()),
        );
        await save;
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
    ...createQuestionReadHandlers(manager, durable?.waitForRecovery),
  };
}
