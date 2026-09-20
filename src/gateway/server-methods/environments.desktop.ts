import {
  type DesktopObserveParams,
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { isDesktopCredentialsRequiredError } from "../desktop/host-source-errors.js";
import { getNodeDesktopService } from "../desktop/node-source-context.js";
import type { DesktopObserveRequester } from "../desktop/observe-requester.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export async function respondDesktopObserve(params: {
  request: DesktopObserveParams;
  respond: RespondFn;
  context: GatewayRequestContext;
  requester?: DesktopObserveRequester;
}) {
  if (params.request.source.kind === "host") {
    if (params.context.getRuntimeConfig().desktop?.host?.enabled !== true) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "gateway host desktop is disabled; enable the Desktop lab (config: desktop.host.enabled=true), then restart the gateway",
        ),
      );
      return;
    }
    if (!params.context.hostDesktopService) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "gateway host desktop is not active; desktop.host.enabled changes require a gateway restart",
        ),
      );
      return;
    }
    try {
      params.respond(
        true,
        await params.context.hostDesktopService.observe({
          control: params.request.control ?? false,
          requester: params.requester,
          ...("credentials" in params.request && params.request.credentials
            ? { credentials: params.request.credentials }
            : {}),
        }),
        undefined,
      );
    } catch (error) {
      if (isDesktopCredentialsRequiredError(error)) {
        params.respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
            details: {
              code: error.detailCode,
              auth: error.auth,
            },
          }),
        );
        return;
      }
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error
            ? error.message
            : "gateway host desktop observe unavailable; verify the VNC server and retry",
        ),
      );
    }
    return;
  }

  if (params.request.source.kind === "node") {
    const service = getNodeDesktopService(params.context);
    if (!service) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node desktop is disabled; explicitly allow desktop.stream, then restart the gateway",
        ),
      );
      return;
    }
    try {
      params.respond(
        true,
        await service.observe({
          nodeId: params.request.source.nodeId,
          control: params.request.control ?? false,
          requester: params.requester,
          ...("credentials" in params.request && params.request.credentials
            ? { credentials: params.request.credentials }
            : {}),
        }),
        undefined,
      );
    } catch (error) {
      if (isDesktopCredentialsRequiredError(error)) {
        params.respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
            details: { code: error.detailCode, auth: error.auth },
          }),
        );
        return;
      }
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "node desktop observe unavailable",
        ),
      );
    }
    return;
  }

  const service = params.context.workerEnvironmentService;
  if (!service) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"),
    );
    return;
  }
  try {
    const result = await service.observeDesktop({
      environmentId: params.request.source.environmentId,
      control: params.request.control ?? false,
      requester: params.requester,
    });
    params.respond(true, result, undefined);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const invalid = code === "environment_not_found" || code === "invalid_state";
    params.respond(
      false,
      undefined,
      errorShape(
        invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        invalid && error instanceof Error ? error.message : "worker desktop observe unavailable",
      ),
    );
  }
}

export async function respondDesktopLaunch(params: {
  environmentId: string;
  app: "browser" | "terminal";
  respond: RespondFn;
  context: GatewayRequestContext;
}) {
  const service = params.context.workerEnvironmentService;
  if (!service) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"),
    );
    return;
  }
  try {
    params.respond(
      true,
      await service.launchDesktopApp({ environmentId: params.environmentId, app: params.app }),
      undefined,
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const invalid =
      code === "environment_not_found" ||
      code === "invalid_state" ||
      code === "desktop_app_not_found" ||
      code === "unsupported_platform";
    const actionable = invalid || code === "launcher_failure";
    params.respond(
      false,
      undefined,
      errorShape(
        invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        actionable && error instanceof Error
          ? error.message
          : "worker desktop app launch unavailable; try again",
      ),
    );
  }
}
