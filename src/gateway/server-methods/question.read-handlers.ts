import {
  ErrorCodes,
  errorShape,
  validateQuestionGetParams,
  validateQuestionListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { canSelectQuestion, usesOwnRunQuestionAccess } from "../question-access.js";
import {
  readDurableQuestionFact,
  projectQuestionContinuationReceipt,
} from "../question-continuation-receipt.js";
import { QuestionManagerError, QuestionManagerErrorCodes } from "../question-manager.errors.js";
import type { QuestionManager } from "../question-manager.js";
import {
  questionNotFound,
  prepareQuestionAuthorization,
  prepareQuestionCommitAuthority,
  withPreparedQuestionSessions,
} from "../question-session-access.js";
import { managerError } from "./question.errors.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
export async function waitForQuestionRecovery(
  options: GatewayRequestHandlerOptions,
  waitForRecovery: () => Promise<void>,
): Promise<boolean> {
  const authority = readGatewayRequestMutationAuthority(options);
  authority.assertCurrent();
  const signal = AbortSignal.any(
    [options.signal, options.client?.connectionSignal, getAsyncWorkSignal()].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
  try {
    await racePromiseWithAbortSignal(waitForRecovery(), signal);
  } catch {
    signal.throwIfAborted();
    authority.assertCurrent();
    options.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Durable question recovery is unavailable. Retry shortly.",
      ),
    );
    return false;
  }
  authority.assertCurrent();
  return true;
}

export function prepareSelectedQuestion(
  manager: QuestionManager,
  options: GatewayRequestHandlerOptions,
  id: string,
  access: "read" | "mutate",
  waitForRecovery?: () => Promise<void>,
) {
  const authority = readGatewayRequestMutationAuthority(options);
  authority.assertCurrent();
  if (!manager.observe(id) && waitForRecovery) {
    return waitForQuestionRecovery(options, waitForRecovery).then((ready) =>
      ready ? selectQuestion(manager, options, id, access) : undefined,
    );
  }
  return selectQuestion(manager, options, id, access);
}

function selectQuestion(
  manager: QuestionManager,
  options: GatewayRequestHandlerOptions,
  id: string,
  access: "read" | "mutate",
) {
  readGatewayRequestMutationAuthority(options).assertCurrent();
  const question = canSelectQuestion(manager, id, options.client) ? manager.get(id) : null;
  if (!question) {
    options.respond(false, undefined, questionNotFound(id));
    return undefined;
  }
  const observation = manager.observe(id, question);
  const authorize = prepareQuestionAuthorization(options, observation, id, access);
  // Preparation can race physical retirement. Only the captured native custody
  // owner may turn that failure into absence; ordinary storage errors remain errors.
  const preparationFailed = async (error: unknown): Promise<never> => {
    const authority = readGatewayRequestMutationAuthority(options);
    authority.assertCurrent();
    if (observation?.sessionAccess?.durableCustody) {
      let retired = false;
      try {
        await readDurableQuestionFact(observation, authority.assertCurrent, () => {
          retired = true;
          manager.retireDurableCustodyObservation(observation);
        });
      } catch {
        authority.assertCurrent();
        throw error;
      }
      authority.assertCurrent();
      if (retired) {
        throw new QuestionManagerError(
          QuestionManagerErrorCodes.NOT_FOUND,
          questionNotFound(id).message,
        );
      }
    }
    throw error;
  };
  return {
    question,
    observation,
    authorize,
    prepareCommitAuthority() {
      return prepareQuestionCommitAuthority(options, observation, id).catch(preparationFailed);
    },
    withCurrent<T>(consume: () => T, includeMembers?: boolean) {
      return withPreparedQuestionSessions(
        options,
        [authorize.target],
        ([prepared]) => {
          const error = authorize.authorize(prepared);
          if (error) {
            options.respond(false, undefined, error);
            return undefined;
          }
          return consume();
        },
        {
          assertCurrent: authorize.assertCurrent,
          ...(includeMembers !== undefined ? { includeMembers } : {}),
        },
      ).catch(preparationFailed);
    },
  };
}

export function createQuestionReadHandlers(
  manager: QuestionManager,
  waitForRecovery?: () => Promise<void>,
): GatewayRequestHandlers {
  return {
    "question.get": async (options) => {
      const { params, respond } = options;
      if (!assertValidParams(params, validateQuestionGetParams, "question.get", respond)) {
        return;
      }
      const selection = prepareSelectedQuestion(
        manager,
        options,
        params.id,
        "read",
        waitForRecovery,
      );
      const selected = selection instanceof Promise ? await selection : selection;
      if (!selected) {
        return;
      }
      const durable = manager.hasDurableCustody(params.id);
      const canonical = durable
        ? await readDurableQuestionFact(
            selected.observation!,
            selected.authorize.assertCurrent,
            () => manager.retireDurableCustodyObservation(selected.observation!),
          )
        : undefined;
      const continuation =
        params.includeContinuation && canonical
          ? projectQuestionContinuationReceipt(canonical)
          : undefined;
      if (durable && !canonical) {
        respond(false, undefined, questionNotFound(params.id));
        return;
      }
      await selected
        .withCurrent(() => {
          respond(
            true,
            {
              question: canonical?.record ?? selected.observation!.record,
              ...(continuation ? { continuation } : {}),
            },
            undefined,
          );
        })
        .catch((error: unknown) => {
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
      if (waitForRecovery && !(await waitForQuestionRecovery(options, waitForRecovery))) {
        return;
      }
      readGatewayRequestMutationAuthority(options).assertCurrent();
      let records = manager
        .list(
          usesOwnRunQuestionAccess(options.client)
            ? (question) => canSelectQuestion(manager, question.id, options.client)
            : undefined,
          Boolean(params.includeContinuation),
        )
        .map((question) => {
          const observation = manager.observe(question.id, question);
          return {
            question,
            observation,
            durable: manager.hasDurableCustody(question.id),
            authorize: prepareQuestionAuthorization(options, observation, question.id, "read"),
          };
        });
      while (true) {
        const canonical = await Promise.all(
          records.map(async ({ observation, authorize, durable }) =>
            observation && durable
              ? readDurableQuestionFact(observation, authorize.assertCurrent, () =>
                  manager.retireDurableCustodyObservation(observation),
                )
              : undefined,
          ),
        );
        // Retired custody cannot contribute a preparation target for healthy siblings.
        const currentRecords = records
          .map((record, index) => Object.assign({}, record, { canonical: canonical[index] }))
          .filter(
            ({ observation, durable, canonical: fact }) =>
              observation?.isCurrent() && (!durable || fact),
          );
        const receipts = params.includeContinuation
          ? currentRecords.map(({ canonical: fact }) =>
              fact ? projectQuestionContinuationReceipt(fact) : undefined,
            )
          : undefined;
        try {
          await withPreparedQuestionSessions(
            options,
            currentRecords.map(({ authorize }) => authorize.target),
            (prepared) => {
              const questions = currentRecords.flatMap(
                ({ question, observation, authorize, durable, canonical: fact }, index) => {
                  const current = fact?.record ?? question;
                  return observation?.isCurrent() &&
                    observation.record === question &&
                    (!durable || fact) &&
                    (current.status === "pending" || params.includeContinuation) &&
                    !authorize.authorize(prepared[index])
                    ? [current]
                    : [];
                },
              );
              const continuations = receipts?.filter(
                (receipt) =>
                  receipt && questions.some((question) => question.id === receipt.questionId),
              );
              respond(true, { questions, ...(continuations ? { continuations } : {}) }, undefined);
            },
            { assertCurrent: readGatewayRequestMutationAuthority(options).assertCurrent },
          );
          return;
        } catch (error) {
          readGatewayRequestMutationAuthority(options).assertCurrent();
          // A source can retire after the canonical reads, during another store's
          // preparation. Only a fresh native custody read can retire its exact
          // observation; storage failures still propagate. Retry only with a
          // strictly smaller captured batch, so unrelated failures cannot spin.
          await Promise.all(
            currentRecords.map(async ({ observation, durable, authorize }) => {
              if (observation?.isCurrent() && durable) {
                await readDurableQuestionFact(observation, authorize.assertCurrent, () =>
                  manager.retireDurableCustodyObservation(observation),
                );
              }
            }),
          );
          const remaining = currentRecords.filter(({ observation }) => observation?.isCurrent());
          if (remaining.length === currentRecords.length) {
            throw error;
          }
          records = remaining;
        }
      }
    },
  };
}
