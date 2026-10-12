import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  ErrorShape,
  GatewayCoreRequestParams,
  ValidationError,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export type Validator<T> = ((params: unknown) => params is T) & {
  errors?: ValidationError[] | null;
};

type ValidatedGatewayRequestHandler<T> = (
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: T },
) => ReturnType<GatewayRequestHandler>;

export function validateGatewayMethodParams<T>(
  params: unknown,
  validate: Validator<T>,
  method: string,
): ErrorShape | undefined {
  if (validate(params)) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
  );
}

export function assertValidParams<T>(
  params: unknown,
  validate: Validator<T>,
  method: string,
  respond: RespondFn,
): params is T {
  const error = validateGatewayMethodParams(params, validate, method);
  if (!error) {
    return true;
  }
  respond(false, undefined, error);
  return false;
}

function hasValidMethodParams<T>(
  options: GatewayRequestHandlerOptions,
  validate: Validator<T>,
  method: string,
): options is GatewayRequestHandlerOptions & { params: T } {
  return assertValidParams(options.params, validate, method, options.respond);
}

export function defineValidatedGatewayHandler<T>(
  method: string,
  validate: Validator<T>,
  handler: ValidatedGatewayRequestHandler<NoInfer<T>>,
  mapError?: (error: unknown) => ErrorShape,
): GatewayRequestHandler {
  const run: ValidatedGatewayRequestHandler<T> = mapError
    ? async (options) => {
        try {
          await handler(options);
        } catch (error) {
          options.respond(false, undefined, mapError(error));
        }
      }
    : handler;
  return (options) => {
    if (!hasValidMethodParams(options, validate, method)) {
      return;
    }
    // Opaque request authority is bound to this exact options object.
    return run(options);
  };
}

/** Bind a core method to its schema before exposing it through the open plugin registry. */
export function defineValidatedGatewayMethod<Method extends keyof GatewayCoreRequestParams>(
  method: Method,
  validate: Validator<NoInfer<GatewayCoreRequestParams[Method]>>,
  handler: ValidatedGatewayRequestHandler<GatewayCoreRequestParams[Method]>,
  mapError?: (error: unknown) => ErrorShape,
): GatewayRequestHandler {
  return defineValidatedGatewayHandler<GatewayCoreRequestParams[Method]>(
    method,
    validate,
    handler,
    mapError,
  );
}
