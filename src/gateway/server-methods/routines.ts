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
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  createRoutine,
  deleteRoutine,
  inspectRoutine,
  listRoutines,
  normalizeRoutineCronCreateInput,
  setRoutineEnabled,
  type RoutineCreateInput,
} from "../../routines/service.js";
import { assertValidCronCreateDelivery } from "./cron.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function respondInvalid(respond: RespondFn, method: string, message: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method}: ${message}`),
  );
}

function respondValidationFailure(
  respond: RespondFn,
  method: string,
  errors: Parameters<typeof formatValidationErrors>[0],
): void {
  respondInvalid(respond, method, formatValidationErrors(errors));
}

function validateRoutineSchedule(respond: RespondFn, method: string, params: RoutineCreateInput) {
  const timestampValidation = validateScheduleTimestamp(params.trigger.schedule);
  if (!timestampValidation.ok) {
    respondInvalid(respond, method, timestampValidation.message);
    return false;
  }
  return true;
}

export const routinesHandlers: GatewayRequestHandlers = {
  "routines.list": async ({ params, respond, context }) => {
    if (!validateRoutinesListParams(params)) {
      respondValidationFailure(respond, "routines.list", validateRoutinesListParams.errors);
      return;
    }
    const result = await listRoutines(params, {
      cron: context.cron,
      cronStorePath: context.cronStorePath,
    });
    respond(true, result);
  },
  "routines.get": async ({ params, respond, context }) => {
    if (!validateRoutinesGetParams(params)) {
      respondValidationFailure(respond, "routines.get", validateRoutinesGetParams.errors);
      return;
    }
    const routine = await inspectRoutine(params.id, {
      cron: context.cron,
      cronStorePath: context.cronStorePath,
    });
    respond(true, { routine: routine ?? null });
  },
  "routines.create": async ({ params, respond, context }) => {
    if (!validateRoutinesCreateParams(params)) {
      respondValidationFailure(respond, "routines.create", validateRoutinesCreateParams.errors);
      return;
    }
    const input = params as RoutineCreateInput & { target?: { delivery?: unknown } };
    try {
      assertCronDeliveryInputNonBlankFields(input.target?.delivery);
    } catch (err) {
      respondInvalid(respond, "routines.create", formatErrorMessage(err));
      return;
    }
    if (!validateRoutineSchedule(respond, "routines.create", input)) {
      return;
    }
    try {
      await assertValidCronCreateDelivery(
        context.getRuntimeConfig(),
        normalizeRoutineCronCreateInput(input),
      );
    } catch (err) {
      respondInvalid(respond, "routines.create", formatErrorMessage(err));
      return;
    }
    try {
      const result = await createRoutine(input, {
        cron: context.cron,
        cronStorePath: context.cronStorePath,
      });
      context.logGateway.info("routines: routine created", {
        routineId: result.routine.id,
        cronJobId: result.routine.trigger.cronJobId,
        idempotent: result.idempotent,
      });
      respond(true, result);
    } catch (err) {
      respondInvalid(respond, "routines.create", formatErrorMessage(err));
    }
  },
  "routines.enable": async ({ params, respond, context }) => {
    if (!validateRoutinesSetEnabledParams(params)) {
      respondValidationFailure(respond, "routines.enable", validateRoutinesSetEnabledParams.errors);
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
      respondInvalid(respond, "routines.enable", formatErrorMessage(err));
    }
  },
  "routines.disable": async ({ params, respond, context }) => {
    if (!validateRoutinesSetEnabledParams(params)) {
      respondValidationFailure(
        respond,
        "routines.disable",
        validateRoutinesSetEnabledParams.errors,
      );
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
      respondInvalid(respond, "routines.disable", formatErrorMessage(err));
    }
  },
  "routines.delete": async ({ params, respond, context }) => {
    if (!validateRoutinesDeleteParams(params)) {
      respondValidationFailure(respond, "routines.delete", validateRoutinesDeleteParams.errors);
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
      respondInvalid(respond, "routines.delete", formatErrorMessage(err));
    }
  },
};
