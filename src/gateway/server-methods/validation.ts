// Validation helpers adapt gateway-protocol validators to standard method
// INVALID_REQUEST responses.
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

/** Type guard function shape produced by gateway-protocol validators. */
export type Validator<T> = ((params: unknown) => params is T) & {
  errors?: ValidationError[] | null;
};

type ValidatedGatewayRequestHandler<T> = (
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: T },
) => ReturnType<GatewayRequestHandler>;

/** Validate params and return the standard method error without emitting a response. */
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

/** Validate params and emit the standard INVALID_REQUEST response on failure. */
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
): GatewayRequestHandler {
  return (options) => {
    if (!hasValidMethodParams(options, validate, method)) {
      return;
    }
    // Opaque request authority is bound to this exact options object.
    return handler(options);
  };
}

/** Bind a core method to its schema before exposing it through the open plugin registry. */
export function defineValidatedGatewayMethod<Method extends keyof GatewayCoreRequestParams>(
  method: Method,
  validate: Validator<NoInfer<GatewayCoreRequestParams[Method]>>,
  handler: ValidatedGatewayRequestHandler<GatewayCoreRequestParams[Method]>,
): GatewayRequestHandler {
  return defineValidatedGatewayHandler<GatewayCoreRequestParams[Method]>(method, validate, handler);
}
