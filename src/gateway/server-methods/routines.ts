// Gateway RPC handlers for durable routine registry operations.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateRoutinesCreateParams,
  validateRoutinesDeleteParams,
  validateRoutinesGetParams,
  validateRoutinesListParams,
  validateRoutinesSetEnabledParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  assertValidCronCreateDelivery,
} from "../../cron/delivery-channel-validation.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  createRoutine,
  deleteRoutine,
  inspectRoutine,
  isRoutineInvalidRequestError,
  listRoutines,
  setRoutineEnabled,
  type RoutineCreateInput,
} from "../../routines/service.js";
import { readCronCallerScope } from "./cron-caller-scope.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

function respondInvalid(respond: RespondFn, method: string, message: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method}: ${message}`),
  );
}

function respondUnavailable(respond: RespondFn, method: string, err: unknown): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, `${method} failed: ${formatErrorMessage(err)}`),
  );
}

function respondRoutineError(respond: RespondFn, method: string, err: unknown): void {
  if (
    isRoutineInvalidRequestError(err) ||
    err instanceof TypeError ||
    err instanceof RangeError ||
    isCronInvalidRequestError(err)
  ) {
    respondInvalid(respond, method, formatErrorMessage(err));
    return;
  }
  respondUnavailable(respond, method, err);
}

function respondValidationFailure(
  respond: RespondFn,
  method: string,
  errors: Parameters<typeof formatValidationErrors>[0],
): void {
  respondInvalid(respond, method, formatValidationErrors(errors));
}

function rejectAgentRuntimeCaller(
  client: GatewayClient | null,
  respond: RespondFn,
  method: string,
): boolean {
  if (!readCronCallerScope(client)) {
    return false;
  }
  respondInvalid(respond, method, "routine registry methods are operator-scoped");
  return true;
}

export const routinesHandlers: GatewayRequestHandlers = {
  "routines.list": async ({ params, respond, context, client }) => {
    if (!validateRoutinesListParams(params)) {
      respondValidationFailure(respond, "routines.list", validateRoutinesListParams.errors);
      return;
    }
    if (rejectAgentRuntimeCaller(client, respond, "routines.list")) {
      return;
    }
    const result = await listRoutines(params, {
      cron: context.cron,
      cronStorePath: context.cronStorePath,
    });
    respond(true, result);
  },
  "routines.get": async ({ params, respond, context, client }) => {
    if (!validateRoutinesGetParams(params)) {
      respondValidationFailure(respond, "routines.get", validateRoutinesGetParams.errors);
      return;
    }
    if (rejectAgentRuntimeCaller(client, respond, "routines.get")) {
      return;
    }
    const routine = await inspectRoutine(params.id, {
      cron: context.cron,
      cronStorePath: context.cronStorePath,
    });
    respond(true, { routine: routine ?? null });
  },
  "routines.create": async ({ params, respond, context, client }) => {
    if (!validateRoutinesCreateParams(params)) {
      respondValidationFailure(respond, "routines.create", validateRoutinesCreateParams.errors);
      return;
    }
    if (rejectAgentRuntimeCaller(client, respond, "routines.create")) {
      return;
    }
    const input = params as RoutineCreateInput;
    try {
      const result = await createRoutine(input, {
        cron: context.cron,
        cronStorePath: context.cronStorePath,
        validateCronCreate: async (cronInput) => {
          assertCronDeliveryInputNonBlankFields(cronInput.delivery);
          await assertValidCronCreateDelivery(context.getRuntimeConfig(), cronInput);
        },
      });
      context.logGateway.info("routines: routine created", {
        routineId: result.routine.id,
        cronJobId: result.routine.trigger.cronJobId,
        idempotent: result.idempotent,
      });
      respond(true, result);
    } catch (err) {
      respondRoutineError(respond, "routines.create", err);
    }
  },
  "routines.enable": async ({ params, respond, context, client }) => {
    if (!validateRoutinesSetEnabledParams(params)) {
      respondValidationFailure(respond, "routines.enable", validateRoutinesSetEnabledParams.errors);
      return;
    }
    if (rejectAgentRuntimeCaller(client, respond, "routines.enable")) {
      return;
    }
    try {
      respond(
        true,
        await setRoutineEnabled(params.id, true, {
          cron: context.cron,
          cronStorePath: context.cronStorePath,
        }),
      );
    } catch (err) {
      respondRoutineError(respond, "routines.enable", err);
    }
  },
  "routines.disable": async ({ params, respond, context, client }) => {
    if (!validateRoutinesSetEnabledParams(params)) {
      respondValidationFailure(
        respond,
        "routines.disable",
        validateRoutinesSetEnabledParams.errors,
      );
      return;
    }
    if (rejectAgentRuntimeCaller(client, respond, "routines.disable")) {
      return;
    }
    try {
      respond(
        true,
        await setRoutineEnabled(params.id, false, {
          cron: context.cron,
          cronStorePath: context.cronStorePath,
        }),
      );
    } catch (err) {
      respondRoutineError(respond, "routines.disable", err);
    }
  },
  "routines.delete": async ({ params, respond, context, client }) => {
    if (!validateRoutinesDeleteParams(params)) {
      respondValidationFailure(respond, "routines.delete", validateRoutinesDeleteParams.errors);
      return;
    }
    if (rejectAgentRuntimeCaller(client, respond, "routines.delete")) {
      return;
    }
    try {
      respond(
        true,
        await deleteRoutine(params.id, {
          cron: context.cron,
          cronStorePath: context.cronStorePath,
        }),
      );
    } catch (err) {
      respondRoutineError(respond, "routines.delete", err);
    }
  },
};
