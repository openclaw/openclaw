import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateWebLoginStartParams,
  validateWebLoginWaitParams,
  type WebLoginStartParams,
  type WebLoginWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listChannelPlugins, normalizeChannelId } from "../../channels/plugins/index.js";
import { listLoadedChannelPluginsForRegistry } from "../../channels/plugins/registry-loaded.js";
import { resolveMissingOfficialExternalChannelPluginRepairHints } from "../../plugins/official-external-plugin-repair-hints.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveRuntimeAccountSnapshot } from "./channels-account.js";
import { respondUnavailable } from "./response.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

const WEB_LOGIN_METHODS = new Set(["web.login.start", "web.login.wait"]);

function resolveWebLoginChannelId(
  raw: string,
  plugins: ReturnType<typeof listLoadedChannelPluginsForRegistry>,
) {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return null;
  }
  return (
    plugins.find(
      (plugin) =>
        normalizeOptionalLowercaseString(plugin.id) === normalized ||
        plugin.meta?.aliases?.some(
          (alias) => normalizeOptionalLowercaseString(alias) === normalized,
        ),
    )?.id ?? null
  );
}

const resolveWebLoginProvider = (channelId?: string) => {
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const plugins = registry ? listLoadedChannelPluginsForRegistry(registry) : listChannelPlugins();
  if (channelId) {
    const normalizedChannelId = registry
      ? resolveWebLoginChannelId(channelId, plugins)
      : normalizeChannelId(channelId);
    return normalizedChannelId
      ? (plugins.find((plugin) => plugin.id === normalizedChannelId) ?? null)
      : null;
  }
  return (
    plugins.find((plugin) =>
      [
        ...(plugin.gatewayMethods ?? []),
        ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name),
      ].some((method) => WEB_LOGIN_METHODS.has(method)),
    ) ?? null
  );
};

type WebLoginProvider = NonNullable<ReturnType<typeof resolveWebLoginProvider>>;
type WebLoginGateway = NonNullable<WebLoginProvider["gateway"]>;
type WebLoginGatewayMethod = "loginWithQrStart" | "loginWithQrWait";

function resolveMissingWebLoginPluginHint(context: GatewayRequestContext): string | null {
  const cfg = context.getRuntimeConfig();
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return null;
  }
  const hints = resolveMissingOfficialExternalChannelPluginRepairHints({
    config: cfg,
    channelIds: Object.keys(channels),
  });
  if (hints.length === 0) {
    return null;
  }
  if (hints.length === 1) {
    return expectDefined(hints[0], "hints entry at 0").repairHint;
  }
  const labels = [...new Set(hints.map((hint) => hint.label))];
  const installCommands = [...new Set(hints.map((hint) => hint.installCommand))];
  const doctorFixCommand = expectDefined(hints[0], "hints entry at 0").doctorFixCommand;
  return `Configured official external channel plugins are missing for ${labels.join(", ")}. Install them with: ${installCommands.join("; ")}, or run: ${doctorFixCommand}.`;
}

function webLoginHandler<
  P extends WebLoginStartParams | WebLoginWaitParams,
  M extends WebLoginGatewayMethod,
>(
  method: string,
  validate: Validator<P>,
  gatewayMethod: M,
  handle: (
    params: P,
    context: GatewayRequestContext,
    request: {
      accountId?: string;
      provider: WebLoginProvider;
      run: NonNullable<WebLoginGateway[M]>;
    },
    respond: RespondFn,
  ) => Promise<void>,
): GatewayRequestHandlers[string] {
  return async ({ params, respond, context }) => {
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    try {
      const accountId = params.accountId;
      const provider = resolveWebLoginProvider(params.channel);
      if (!provider) {
        const repairHint = resolveMissingWebLoginPluginHint(context);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            repairHint
              ? `web login provider is not available. ${repairHint}`
              : "web login provider is not available",
          ),
        );
        return;
      }
      const gateway = provider.gateway;
      const run = gateway?.[gatewayMethod];
      if (!run) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `web login is not supported by provider ${provider.id}`,
          ),
        );
        return;
      }
      await handle(
        params,
        context,
        { accountId, provider, run: run.bind(gateway) as NonNullable<WebLoginGateway[M]> },
        respond,
      );
    } catch (err) {
      respondUnavailable(respond, err);
    }
  };
}

export const webHandlers: GatewayRequestHandlers = {
  "web.login.start": webLoginHandler(
    "web.login.start",
    validateWebLoginStartParams,
    "loginWithQrStart",
    async (params, context, { accountId, provider, run }, respond) => {
      const runtime = context.getRuntimeSnapshot();
      const account = accountId
        ? resolveRuntimeAccountSnapshot({ runtime, channelId: provider.id, accountId })
        : runtime.channels[provider.id];
      const wasRunning = account?.running === true;
      const forceLogin = Boolean(params.force);
      const stoppedBeforeLogin = forceLogin || !wasRunning;
      if (stoppedBeforeLogin) {
        await context.stopChannel(provider.id, accountId);
      }
      const result = await run({
        force: forceLogin,
        timeoutMs: params.timeoutMs,
        verbose: Boolean(params.verbose),
        accountId,
      });
      const stoppedAfterQrTakeover = !stoppedBeforeLogin && Boolean(result.qrDataUrl);
      if (stoppedAfterQrTakeover) {
        await context.stopChannel(provider.id, accountId);
      }
      const stoppedForLogin = stoppedBeforeLogin || stoppedAfterQrTakeover;
      // A failed start without a QR code must also restore the running account.
      if (stoppedForLogin && (result.connected || (wasRunning && !result.qrDataUrl))) {
        await context.startChannel(provider.id, accountId);
      }
      respond(true, result, undefined);
    },
  ),
  "web.login.wait": webLoginHandler(
    "web.login.wait",
    validateWebLoginWaitParams,
    "loginWithQrWait",
    async (params, context, { accountId, provider, run }, respond) => {
      const result = await run({
        timeoutMs: params.timeoutMs,
        accountId,
        sessionKey: params.sessionKey,
        currentQrDataUrl: params.currentQrDataUrl,
      });
      if (result.connected) {
        await context.startChannel(provider.id, accountId);
      }
      respond(true, result, undefined);
    },
  ),
};
