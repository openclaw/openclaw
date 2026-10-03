import {
  ErrorCodes,
  errorShape,
  type ProtocolValidator,
  validateUsersAuthConnectCancelParams,
  validateUsersAuthConnectAnswerParams,
  validateUsersAuthConnectStartParams,
  validateUsersAuthConnectStatusParams,
  validateUsersAuthConnectCatalogParams,
  validateUsersListAuthLinksParams,
  validateUsersLinkAuthProfileParams,
  validateUsersUnlinkAuthProfileParams,
  validateUsersListModelAccountsParams,
  validateUsersSelectModelAccountParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { UserProfileNotFoundError } from "../../state/user-profiles.js";
import type { ModelAccountConnectAction } from "../model-account-authority.js";
import {
  ModelAccountConnectAuthorityError,
  ModelAccountConnectInputError,
} from "../model-account-connect-errors.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "./types.js";
import { prepareUserModelAccountAction } from "./users-model-account-access.js";
import { defineValidatedGatewayHandler } from "./validation.js";

function connectHandler<P extends { profileId?: string }>(
  method: string,
  validate: ProtocolValidator<P>,
  run: (
    service: NonNullable<GatewayRequestContext["modelAccountConnectService"]>,
    action: ModelAccountConnectAction,
    params: P,
  ) => unknown,
  requiredScope: "operator.read" | "operator.write" | "operator.admin" = "operator.write",
): GatewayRequestHandler {
  return defineValidatedGatewayHandler(
    method,
    validate,
    async (options) => {
      const action = await prepareUserModelAccountAction(
        options,
        options.params.profileId,
        requiredScope,
      );
      const service = options.context.modelAccountConnectService;
      if (!service) {
        throw new Error("Model-account service is not running.");
      }
      const result = await run(service, action, options.params);
      action.assertCurrent();
      options.respond(true, result);
    },
    (error) =>
      error instanceof ModelAccountConnectAuthorityError
        ? errorShape(ErrorCodes.FORBIDDEN, error.message)
        : error instanceof ModelAccountConnectInputError ||
            error instanceof UserProfileNotFoundError
          ? errorShape(ErrorCodes.INVALID_REQUEST, error.message)
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              "Model account connect is unavailable right now; try again shortly.",
            ),
  );
}

export const usersAuthConnectHandlers: GatewayRequestHandlers = {
  "users.listAuthLinks": connectHandler(
    "users.listAuthLinks",
    validateUsersListAuthLinksParams,
    (service, action) => service.listLinks(action),
    "operator.read",
  ),
  "users.linkAuthProfile": connectHandler(
    "users.linkAuthProfile",
    validateUsersLinkAuthProfileParams,
    (service, action, params) => service.link(action, params.authProfileId),
    // Choosing an existing shared credential remains an explicit admin decision.
    "operator.admin",
  ),
  "users.unlinkAuthProfile": connectHandler(
    "users.unlinkAuthProfile",
    validateUsersUnlinkAuthProfileParams,
    (service, action, params) => service.unlink(action, params.provider),
  ),
  "users.listModelAccounts": connectHandler(
    "users.listModelAccounts",
    validateUsersListModelAccountsParams,
    (service, action, params) => service.list(action, params.cursor),
    "operator.read",
  ),
  "users.selectModelAccount": connectHandler(
    "users.selectModelAccount",
    validateUsersSelectModelAccountParams,
    (service, action, params) => service.select(action, params.authProfileId),
  ),
  "users.authConnect.start": connectHandler(
    "users.authConnect.start",
    validateUsersAuthConnectStartParams,
    (service, action, params) => service.start(action, params.provider, params.method),
  ),
  "users.authConnect.answer": connectHandler(
    "users.authConnect.answer",
    validateUsersAuthConnectAnswerParams,
    (service, action, params) =>
      service.answer(action, params.connectId, params.stepId, params.value),
  ),
  "users.authConnect.status": connectHandler(
    "users.authConnect.status",
    validateUsersAuthConnectStatusParams,
    (service, action, params) => service.status(action, params.connectId),
  ),
  "users.authConnect.cancel": connectHandler(
    "users.authConnect.cancel",
    validateUsersAuthConnectCancelParams,
    (service, action, params) => service.cancel(action, params.connectId),
  ),
  "users.authConnect.catalog": connectHandler(
    "users.authConnect.catalog",
    validateUsersAuthConnectCatalogParams,
    (service, action) => service.catalog(action),
  ),
};
