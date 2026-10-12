import {
  type DesktopObserveParams,
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { DesktopCredentialsRequiredError } from "../desktop/host-source-errors.js";
import { getNodeDesktopService } from "../desktop/node-source-context.js";
import type { DesktopObserveRequester } from "../desktop/observe-requester.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

function respondDesktopObserveFailure(respond: RespondFn, error: unknown, fallback: string) {
  if (error instanceof DesktopCredentialsRequiredError) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
        details: { code: error.detailCode, auth: error.auth },
      }),
    );
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : fallback),
  );
}

export async function respondDesktopObserve(params: {
  request: DesktopObserveParams;
  respond: RespondFn;
  context: GatewayRequestContext;
  requester?: DesktopObserveRequester;
}) {
  const { request, context, respond } = params;
  if (request.source.kind !== "environment") {
    const host = request.source.kind === "host";
    if (host && context.getRuntimeConfig().desktop?.host?.enabled !== true) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "gateway host desktop is disabled; enable the Desktop lab (config: desktop.host.enabled=true)",
        ),
      );
      return;
    }
    const options = {
      control: request.control ?? false,
      requester: params.requester,
      ...("credentials" in request && request.credentials
        ? { credentials: request.credentials }
        : {}),
    };
    const hostService = host ? context.hostDesktopService : undefined;
    const nodeService = host ? undefined : getNodeDesktopService(context);
    const observe =
      request.source.kind === "host"
        ? hostService?.observe.bind(hostService, options)
        : nodeService?.observe.bind(nodeService, { ...options, nodeId: request.source.nodeId });
    if (!observe) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          host
            ? "gateway host desktop is unavailable in this Gateway runtime"
            : "node desktop service is unavailable; reconnect to the Gateway and retry",
        ),
      );
      return;
    }
    try {
      respond(true, await observe(), undefined);
    } catch (error) {
      respondDesktopObserveFailure(
        respond,
        error,
        host
          ? "gateway host desktop observe unavailable; verify the VNC server and retry"
          : "node desktop observe unavailable",
      );
    }
    return;
  }

  const { environmentId } = request.source;
  await respondWorkerDesktop(params, "observe", (service) =>
    service.observeDesktop({
      environmentId,
      control: params.request.control ?? false,
      requester: params.requester,
    }),
  );
}

export async function respondDesktopLaunch(params: {
  environmentId: string;
  app: "browser" | "terminal";
  respond: RespondFn;
  context: GatewayRequestContext;
}) {
  await respondWorkerDesktop(params, "launch", (service) =>
    service.launchDesktopApp({ environmentId: params.environmentId, app: params.app }),
  );
}

async function respondWorkerDesktop(
  params: { respond: RespondFn; context: GatewayRequestContext },
  operation: "observe" | "launch",
  run: (
    service: NonNullable<GatewayRequestContext["workerEnvironmentService"]>,
  ) => Promise<unknown>,
) {
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
    params.respond(true, await run(service), undefined);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const invalid =
      code === "environment_not_found" ||
      code === "invalid_state" ||
      (operation === "launch" &&
        (code === "desktop_app_not_found" || code === "unsupported_platform"));
    const actionable = invalid || (operation === "launch" && code === "launcher_failure");
    params.respond(
      false,
      undefined,
      errorShape(
        invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        actionable && error instanceof Error
          ? error.message
          : operation === "launch"
            ? "worker desktop app launch unavailable; try again"
            : "worker desktop observe unavailable",
      ),
    );
  }
}
