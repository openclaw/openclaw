import type { IncomingMessage, ServerResponse } from "node:http";
import { isControlUiFocusPath } from "@openclaw/session-url-contract";
import { ARTIFACT_DOWNLOAD_PATH } from "../../packages/gateway-protocol/src/artifact-download.js";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { isCanvasDocumentHttpPath } from "../canvas/constants.js";
import { getRuntimeConfig } from "../config/io.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { readTailscaleWhoisIdentity } from "../infra/tailscale.js";
import { parseDevicePairingJoinRequestPath } from "../pairing/join-code.js";
import { getWebhookLegacyListener } from "../plugins/http-legacy-listener.js";
import { NODE_WORKER_BUNDLE_TRANSFER_PATH } from "../worker/node-bundle-install-protocol.js";
import { resolveAssistantAgentId } from "./assistant-identity.js";
import { parseControlUiResourcePath } from "./control-ui-contract.js";
import { respondNotFound, respondPlainText } from "./control-ui-http-utils.js";
import {
  CONTROL_UI_IMAGE_HTTP_ROUTES,
  CONTROL_UI_USER_IMAGE_HTTP_ROUTES,
} from "./control-ui-image-http-routes.js";
import { controlUiPluginAssetRoot } from "./control-ui-plugin-assets-contract.js";
import { resolveAssistantMediaRoutePath } from "./control-ui-resource-routes.js";
import {
  classifyControlUiRequest,
  isControlUiApprovalDocumentPath,
  isControlUiPluginManagerRequest,
} from "./control-ui-routing.js";
import { createControlUiSessionRoutes } from "./control-ui-session-routes.js";
import { isControlUiSharePath } from "./control-ui-share.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import {
  classifyGatewayProbePath,
  classifyMcpAppStandalonePath,
  classifyNodeWorkerBundleTransferPath,
  classifyNodeWorkspaceTransferPath,
  classifyWorkerGatewayPath,
  classifyWorkerBootstrapArtifactTransferPath,
  WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH,
} from "./gateway-http-route-contracts.js";
import type { authorizePluginGatewayHttpRequestOrReply } from "./http-auth-utils.js";
import {
  finishFailedGatewayHttpResponse,
  sendGatewayAuthFailure,
  setDefaultSecurityHeaders,
  isWebSocketUpgradeRequest,
} from "./http-common.js";
import {
  finishGatewayHttpAuthorityError,
  runGatewayHttpRequest,
} from "./http-request-authority.js";
import {
  markGatewayIngressTransport,
  prepareGatewayIngressAttribution,
} from "./ingress-attribution.js";
import { normalizePluginNodeCapabilityScopedUrl } from "./plugin-node-capability.js";
import {
  handleProviderOAuthCallback,
  PROVIDER_OAUTH_CALLBACK_PATH,
} from "./provider-browser-auth.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
  assertRemoteControlUiGatewayAuth,
} from "./remote-control-ui-context.js";
import {
  resolveRemoteControlUiHttpRoute,
  type RemoteControlUiHttpRoute,
} from "./remote-control-ui-http-routing.js";
import {
  getNativeHookRelayModule,
  getControlUiModule,
  getControlUiPluginAssetsModule,
  getCanvasServeModule,
  getBoardHttpModule,
  getEmbeddingsHttpModule,
  getManagedMediaAttachmentsModule,
  getArtifactDownloadsModule,
  getMcpAppStandaloneModule,
  getModelsHttpModule,
  getOpenAiHttpModule,
  getOpenResponsesHttpModule,
  getSessionHistoryHttpModule,
  getSessionKillHttpModule,
  getToolsInvokeHttpModule,
  getDevicePairingJoinHttpModule,
  getPluginNodeCapabilityAuthModule,
  getHttpAuthUtilsModule,
  getPluginRouteRuntimeScopesModule,
} from "./server-http-modules.js";
import {
  getCachedPluginGatewayAuthBypassPaths,
  shouldEnforceDefaultPluginGatewayAuth,
} from "./server-http-plugin-auth.js";
import { handleGatewayProbeRequest } from "./server-http-probes.js";
import type { GatewayHttpRequestHandler, GatewayHttpServerOptions } from "./server-http.types.js";
import { runWithGatewayHttpWorkAdmission } from "./server/http-work-admission.js";
import { resolvePluginRoutePathContext } from "./server/plugins-http/path-context.js";
import { isTerminalConfigEnabled } from "./terminal/enabled.js";
import { handleArtifactTransferHttpRequest } from "./worker-environments/artifact-transfer-http.js";
import { handleNodeWorkspaceTransferHttpRequest } from "./worker-environments/node-workspace-transfer-http.js";

type GatewayHttpRequestStage = () => Promise<boolean> | boolean;

/** Listener and service transports enter the same admission and route owner. */
export function createGatewayHttpRequestHandler(
  opts: Omit<GatewayHttpServerOptions, "testListener" | "tlsOptions">,
): GatewayHttpRequestHandler {
  const {
    clients,
    controlUiBasePath,
    controlUiRoot,
    handleHooksRequest,
    handlePluginRequest,
    shouldEnforcePluginGatewayAuth,
    resolvePluginNodeCapabilityRoute,
    resolvedAuth,
    rateLimiter,
    joinRateLimiter,
    getReadiness,
    getStartup,
  } = opts;
  const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
  const loadGatewayConfig = opts.getRuntimeConfig ?? getRuntimeConfig;
  const controlUiRouteBasePath =
    controlUiBasePath && controlUiBasePath !== "/" ? controlUiBasePath.replace(/\/$/, "") : "";
  const pluginAssetRoot = controlUiPluginAssetRoot(controlUiRouteBasePath);
  const publicSessionRoute = createControlUiSessionRoutes(opts);
  const handleServerRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    expectation?: "continue" | "reject",
  ) => {
    if (!getRemoteControlUiIngressContext(req)) {
      markGatewayIngressTransport(req, opts.ingressTransport ?? { kind: "ordinary" });
    }
    return runGatewayHttpRequest(req, res, opts.httpRequestLifetime, () =>
      runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
        handleRequest(req, res, expectation),
      ),
    ).catch((error: unknown) => {
      console.error("[gateway-http] failed to finalize request:", error);
      if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  };

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    expectation?: "continue" | "reject",
  ): Promise<"failed" | undefined> {
    const remoteIngress = getRemoteControlUiIngressContext(req);
    if (remoteIngress) {
      assertRemoteControlUiIngressCurrent(remoteIngress);
      assertRemoteControlUiGatewayAuth(remoteIngress, getResolvedAuth(), loadGatewayConfig());
    }
    // Legacy ports retain their plugin's raw URLs and wire responses, not Gateway endpoints.
    if (getWebhookLegacyListener(req)) {
      try {
        if (!(await handlePluginRequest?.(req, res)) && !res.writableEnded && !res.destroyed) {
          res.writeHead(404);
          res.end();
        }
      } catch (error) {
        if (finishGatewayHttpAuthorityError(res, error)) {
          return undefined;
        }
        console.error("[gateway-http] legacy plugin request failed:", error);
        res.destroy(error instanceof Error ? error : undefined);
        return "failed";
      }
      return undefined;
    }
    // Read only the published snapshot: even liveness and rejection responses need
    // current headers without depending on config IO or auth resolution.
    setDefaultSecurityHeaders(res, getRuntimeConfigSnapshot()?.gateway?.http?.securityHeaders);
    // Preserve Node's version/token classification while deferring its response
    // until admission; reparsing Expect here would change HTTP/1.0 semantics.
    if (expectation === "reject") {
      res.writeHead(417);
      res.end();
      return undefined;
    }
    if (expectation === "continue") {
      res.writeContinue();
    }

    // Don't interfere with real WebSocket upgrades; ws handles the 'upgrade' event.
    if (isWebSocketUpgradeRequest(req)) {
      return undefined;
    }
    if (req.headers.upgrade !== undefined) {
      res.statusCode = 400;
      res.setHeader("Connection", "close");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Bad Request");
      return undefined;
    }

    try {
      const requestPath = URL.parse(req.url ?? "/", "http://localhost")?.pathname;
      if (requestPath === undefined) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return undefined;
      }
      const remoteRoute = remoteIngress
        ? resolveRemoteControlUiHttpRoute(
            req,
            controlUiRouteBasePath,
            remoteIngress.operatorScopeCeiling,
          )
        : undefined;
      if (remoteIngress && !remoteRoute) {
        respondNotFound(res);
        return undefined;
      }
      if (classifyGatewayProbePath(requestPath) === "live") {
        await handleGatewayProbeRequest(
          req,
          res,
          requestPath,
          resolvedAuth,
          [],
          false,
          rateLimiter,
          getReadiness,
          getStartup,
        );
        return undefined;
      }

      const configSnapshot = loadGatewayConfig();
      const controlUiEnabled =
        opts.controlUiEnabled ?? configSnapshot.gateway?.controlUi?.enabled ?? true;
      // Pin endpoint admission and input limits to the same request snapshot.
      // Only explicit server overrides survive config reloads.
      const openAiChatCompletionsConfig = configSnapshot.gateway?.http?.endpoints?.chatCompletions;
      const openResponsesConfig = configSnapshot.gateway?.http?.endpoints?.responses;
      const openAiChatCompletionsEnabled =
        opts.openAiChatCompletionsEnabled ?? openAiChatCompletionsConfig?.enabled ?? false;
      const openResponsesEnabled =
        opts.openResponsesEnabled ?? openResponsesConfig?.enabled ?? false;
      const openAiCompatEnabled = openAiChatCompletionsEnabled || openResponsesEnabled;
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const ingressAttribution = prepareGatewayIngressAttribution({
        req,
        trustedProxies,
        allowRealIpFallback,
        // HTTP authorization must observe Tailnet revocation on the next request.
        // WebSocket upgrades retain the ordinary cache because they authenticate once.
        tailscaleWhois: (ip) =>
          readTailscaleWhoisIdentity(ip, undefined, { cacheTtlMs: 0, errorTtlMs: 0 }),
      });
      const scopedNodeCapability = normalizePluginNodeCapabilityScopedUrl(req.url ?? "/");
      if (scopedNodeCapability.malformedScopedPath) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return undefined;
      }
      if (scopedNodeCapability.rewrittenUrl) {
        // Scoped capability URLs are normalized before auth/routing so built-in handlers,
        // plugin route matching, and audit context all see the same canonical path.
        req.url = scopedNodeCapability.rewrittenUrl;
      }
      const scopedRequestPath = scopedNodeCapability.pathname;
      const pluginPathContext = resolvePluginRoutePathContext(scopedRequestPath);
      const nodeCapability = resolvePluginNodeCapabilityRoute?.(pluginPathContext);
      if (ingressAttribution.kind === "unattributable-proxy") {
        opts.reportUnattributableProxy?.(ingressAttribution);
        if (
          !nodeCapability &&
          handlePluginRequest &&
          opts.isPluginAuthenticatedRoute?.(pluginPathContext) &&
          (await handlePluginRequest(req, res, pluginPathContext, {
            gatewayRequestClientIp: ingressAttribution.remoteAddress,
          }))
        ) {
          return undefined;
        }
        sendGatewayAuthFailure(res, { ok: false, reason: ingressAttribution.reason });
        return undefined;
      }
      const requestClientIp = ingressAttribution.clientIp;
      const resolvedAuthValue = getResolvedAuth();
      const routeAuth = {
        auth: resolvedAuthValue,
        cfg: configSnapshot,
        getRuntimeConfig: loadGatewayConfig,
        getResolvedAuth,
        trustedProxies,
        allowRealIpFallback,
        rateLimiter,
      };
      const operatorAuth = () => ({
        ...routeAuth,
        resolveGatewayContext: opts.getGatewayRequestContext?.()?.resolveGatewayContext,
      });
      const controlUiRouteOptions = {
        basePath: controlUiBasePath,
        config: configSnapshot,
        ...routeAuth,
      };
      const loadControlUi = () => {
        const url = req.url ? new URL(req.url, "http://localhost") : undefined;
        // Media owns its method/query policy, including explicit-allow POSTs.
        // Classify the current URL so plugin fallthrough cannot load unrelated UI code.
        return url &&
          (url.pathname === resolveAssistantMediaRoutePath(controlUiBasePath) ||
            classifyControlUiRequest({
              basePath: normalizeControlUiBasePath(controlUiBasePath),
              pathname: url.pathname,
              search: url.search,
              method: req.method,
              accept: req.headers.accept,
            }).kind !== "not-control-ui")
          ? getControlUiModule()
          : undefined;
      };
      const handleControlUiRequest = async () =>
        (await loadControlUi())?.handleControlUiHttpRequest(req, res, {
          ...controlUiRouteOptions,
          terminalEnabled: opts.isTerminalEnabled?.() ?? isTerminalConfigEnabled(configSnapshot),
          agentId: resolveAssistantAgentId(configSnapshot),
          root: controlUiRoot,
        }) ?? false;
      const handleStandaloneControlUiRequest = async () => {
        if (!controlUiEnabled || !(await handleControlUiRequest())) {
          respondNotFound(res);
        }
        return true;
      };
      const requestStages: GatewayHttpRequestStage[] = remoteIngress
        ? []
        : [
            () =>
              handleGatewayProbeRequest(
                req,
                res,
                scopedRequestPath,
                resolvedAuthValue,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
                getReadiness,
                getStartup,
              ),
          ];
      const addRequestStage = (
        enabled: boolean,
        stage: GatewayHttpRequestStage,
        admitted = false,
        remoteOwner?: RemoteControlUiHttpRoute,
      ) => {
        if (enabled && (!remoteIngress || remoteOwner === remoteRoute)) {
          requestStages.push(admitted ? () => runWithGatewayHttpWorkAdmission(res, stage) : stage);
        }
      };
      const addAdmittedStage = (
        enabled: boolean,
        stage: GatewayHttpRequestStage,
        remoteOwner?: RemoteControlUiHttpRoute,
      ) => addRequestStage(enabled, stage, true, remoteOwner);

      const workerGatewayRoute = classifyWorkerGatewayPath(scopedRequestPath);
      addRequestStage(workerGatewayRoute !== "outside", () => {
        respondNotFound(res);
        return true;
      });

      const transferRequest = {
        req,
        res,
        clientIp: ingressAttribution.rateLimit.subject.key,
        rateLimiter: joinRateLimiter,
      };
      addAdmittedStage(scopedRequestPath.startsWith("/__openclaw__/native-hook"), async () =>
        (await getNativeHookRelayModule()).handleNativeHookRelayHttpRequest(transferRequest),
      );
      addAdmittedStage(
        classifyWorkerBootstrapArtifactTransferPath(scopedRequestPath) !== "outside",
        () =>
          handleArtifactTransferHttpRequest({
            classifyPath: classifyWorkerBootstrapArtifactTransferPath,
            routePrefix: `${WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH}/artifacts/`,
            ...transferRequest,
            callback: opts.handleWorkerBootstrapArtifactTransferRequest,
          }),
      );

      addAdmittedStage(classifyNodeWorkerBundleTransferPath(scopedRequestPath) !== "outside", () =>
        handleArtifactTransferHttpRequest({
          classifyPath: classifyNodeWorkerBundleTransferPath,
          routePrefix: `${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/`,
          ...transferRequest,
          callback: opts.handleNodeWorkerBundleTransferRequest,
        }),
      );

      addAdmittedStage(classifyNodeWorkspaceTransferPath(scopedRequestPath) !== "outside", () =>
        handleNodeWorkspaceTransferHttpRequest({
          ...transferRequest,
          callback: opts.handleNodeWorkspaceTransferRequest,
        }),
      );

      const devicePairingJoinShortcode = parseDevicePairingJoinRequestPath(scopedRequestPath);
      if (devicePairingJoinShortcode !== null) {
        addAdmittedStage(true, async () =>
          (await getDevicePairingJoinHttpModule()).handleDevicePairingJoinHttpRequest({
            ...transferRequest,
            shortcode: devicePairingJoinShortcode,
          }),
        );
      }

      addAdmittedStage(scopedRequestPath === PROVIDER_OAUTH_CALLBACK_PATH, () =>
        handleProviderOAuthCallback(req, res),
      );
      addAdmittedStage(
        scopedRequestPath.startsWith(ARTIFACT_DOWNLOAD_PATH) ||
          (controlUiRouteBasePath.length > 0 &&
            scopedRequestPath.startsWith(`${controlUiRouteBasePath}${ARTIFACT_DOWNLOAD_PATH}`)),
        async () =>
          (await getArtifactDownloadsModule()).handleArtifactDownloadHttpRequest(req, res, {
            clients,
            basePath: controlUiRouteBasePath,
          }),
        "artifact",
      );
      // Before hooks: an operator hooks.path of "/oauth" would otherwise claim
      // this exact GET and 405 every provider redirect. The claim is exact-path
      // and config-gated, so preceding hooks cannot shadow any hook route.
      addAdmittedStage(
        req.method === "GET" &&
          scopedRequestPath === "/oauth/mcp/callback" &&
          Boolean(opts.handleMcpOAuthCallbackRequest),
        () => opts.handleMcpOAuthCallbackRequest?.(req, res) ?? false,
      );
      // The hook owner claims only its configured base path before entering HTTP admission;
      // this unconditional dispatcher must stay plain so unrelated routes can fall through.
      addRequestStage(true, () => handleHooksRequest(req, res));
      addAdmittedStage(
        Boolean(opts.handleWatchNodeRequest) && scopedRequestPath.startsWith("/api/nodes/watch/"),
        () => opts.handleWatchNodeRequest?.(req, res) ?? false,
      );
      addAdmittedStage(
        openAiCompatEnabled &&
          (scopedRequestPath === "/v1/models" || scopedRequestPath.startsWith("/v1/models/")),
        async () =>
          (await getModelsHttpModule()).handleOpenAiModelsHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(openAiCompatEnabled && scopedRequestPath === "/v1/embeddings", async () =>
        (await getEmbeddingsHttpModule()).handleOpenAiEmbeddingsHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(scopedRequestPath === "/tools/invoke", async () =>
        (await getToolsInvokeHttpModule()).handleToolsInvokeHttpRequest(req, res, operatorAuth()),
      );
      addAdmittedStage(/^\/sessions\/[^/]+\/kill$/.test(scopedRequestPath), async () =>
        (await getSessionKillHttpModule()).handleSessionKillHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(/^\/sessions\/[^/]+\/history$/.test(scopedRequestPath), async () =>
        (await getSessionHistoryHttpModule()).handleSessionHistoryHttpRequest(req, res, {
          ...routeAuth,
          getCommittedRuntimeConfig: () =>
            opts.getGatewayRequestContext?.()?.getCommittedRuntimeConfig?.() ?? loadGatewayConfig(),
        }),
      );
      addAdmittedStage(
        scopedRequestPath.startsWith("/__openclaw__/board/"),
        async () =>
          (await getBoardHttpModule()).handleBoardHttpRequest(req, res, {
            resolveGatewayContext: opts.getGatewayRequestContext?.()?.resolveGatewayContext,
          }),
        "board",
      );
      addAdmittedStage(
        scopedRequestPath.startsWith(pluginAssetRoot),
        async () => {
          if (!controlUiEnabled) {
            respondNotFound(res);
            return true;
          }
          return await (
            await getControlUiPluginAssetsModule()
          ).handleControlUiPluginAssetRequest(req, res, controlUiRouteOptions);
        },
        "native-assets",
      );
      for (const [parse, loadHandler] of CONTROL_UI_USER_IMAGE_HTTP_ROUTES) {
        addAdmittedStage(
          parse(scopedRequestPath, controlUiRouteBasePath).matched,
          async () =>
            (await loadHandler())(req, res, scopedRequestPath, {
              ...routeAuth,
              basePath: controlUiRouteBasePath,
            }),
          "resource",
        );
      }
      addAdmittedStage(openResponsesEnabled && scopedRequestPath === "/v1/responses", async () =>
        (await getOpenResponsesHttpModule()).handleOpenResponsesHttpRequest(req, res, {
          ...operatorAuth(),
          config: openResponsesConfig,
        }),
      );
      addAdmittedStage(
        openAiChatCompletionsEnabled && scopedRequestPath === "/v1/chat/completions",
        async () =>
          (await getOpenAiHttpModule()).handleOpenAiHttpRequest(req, res, {
            ...operatorAuth(),
            config: openAiChatCompletionsConfig,
          }),
      );
      const approvalDocument = isControlUiApprovalDocumentPath({
        basePath: controlUiBasePath,
        pathname: scopedRequestPath,
      });
      const focusDocument = isControlUiFocusPath(scopedRequestPath, controlUiBasePath);
      const publicSessionPath = publicSessionRoute.matches(scopedRequestPath, req.url);
      addRequestStage(!controlUiEnabled && publicSessionPath, () => publicSessionRoute.reject(res));
      addAdmittedStage(controlUiEnabled && publicSessionPath, () =>
        publicSessionRoute.serve({
          ...routeAuth,
          req,
          res,
          config: configSnapshot,
          ingress: ingressAttribution,
        }),
      );
      addRequestStage(
        approvalDocument ||
          (isControlUiSharePath(scopedRequestPath, controlUiRouteBasePath) && !publicSessionPath),
        handleStandaloneControlUiRequest,
      );
      addRequestStage(Boolean(nodeCapability), async () => {
        const { authorizePluginNodeCapabilityRequest } = await getPluginNodeCapabilityAuthModule();
        const ok = await authorizePluginNodeCapabilityRequest({
          req,
          auth: resolvedAuthValue,
          trustedProxies,
          allowRealIpFallback,
          clients,
          nodeCapability: nodeCapability!,
          capability: scopedNodeCapability.capability,
          rateLimiter,
        });
        if (!ok.ok) {
          sendGatewayAuthFailure(res, ok);
          return true;
        }
        return false;
      });
      addRequestStage(
        Boolean(nodeCapability) &&
          isCoreCanvasHostEnabled(configSnapshot) &&
          isCanvasDocumentHttpPath(scopedRequestPath),
        async () => (await getCanvasServeModule()).handleCanvasDocumentHttpRequest(req, res),
      );
      // This page must remain reachable when a plugin route is broken so the
      // operator can disable it. Other explicit plugin routes retain precedence.
      addRequestStage(
        controlUiEnabled &&
          isControlUiPluginManagerRequest({
            basePath: controlUiBasePath,
            pathname: scopedRequestPath,
            method: req.method,
          }),
        handleControlUiRequest,
        false,
        "document",
      );
      const mcpAppRoute = classifyMcpAppStandalonePath(scopedRequestPath);
      addAdmittedStage(
        configSnapshot.mcp?.apps?.enabled === true &&
          (mcpAppRoute === "shell" || mcpAppRoute === "view"),
        async () => {
          const standalone = await getMcpAppStandaloneModule();
          return await standalone.handleMcpAppStandaloneHttpRequest(req, res, {
            sandboxPort: configSnapshot.mcp?.apps?.sandboxPort,
            sandboxOrigin: configSnapshot.mcp?.apps?.sandboxOrigin,
          });
        },
      );
      // Core and recovery routes run first, then plugin routes, then read-only Control UI
      // surfaces. Non-GET requests the SPA does not claim reach the startup 503 before final 404.
      if (handlePluginRequest && (!remoteIngress || remoteRoute === "plugin-panel")) {
        let pluginAuthorization: Awaited<
          ReturnType<typeof authorizePluginGatewayHttpRequestOrReply>
        > = null;
        // Auth and dispatch stay separate so authorized context reaches the handler.
        requestStages.push(
          async () => {
            if (
              !remoteIngress &&
              (!(shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth)(
                pluginPathContext,
              ) ||
                (await getCachedPluginGatewayAuthBypassPaths(configSnapshot)).has(
                  scopedRequestPath,
                ))
            ) {
              return false;
            }
            // Bypass paths come only from activated channel plugins; every other protected
            // route must authorize before runtime scopes are derived.
            const { authorizePluginGatewayHttpRequestOrReply } = await getHttpAuthUtilsModule();
            const { resolvePluginRouteRuntimeOperatorScopes } =
              await getPluginRouteRuntimeScopesModule();
            pluginAuthorization = await authorizePluginGatewayHttpRequestOrReply({
              req,
              res,
              ...routeAuth,
              requestPath: scopedRequestPath,
              resolveOperatorScopes: resolvePluginRouteRuntimeOperatorScopes,
            });
            return !pluginAuthorization;
          },
          () => {
            if (pluginAuthorization?.requestAuth.hasCurrentClientAuthority?.() === false) {
              sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
              return true;
            }
            return handlePluginRequest(req, res, pluginPathContext, {
              gatewayAuthSatisfied: pluginAuthorization !== null,
              gatewayRequestAuth: pluginAuthorization?.requestAuth,
              gatewayRequestOperatorScopes: pluginAuthorization?.operatorScopes,
              gatewayRequestClientIp: requestClientIp,
            });
          },
        );
      }

      addRequestStage(focusDocument, handleStandaloneControlUiRequest, false, "document");

      addRequestStage(
        scopedRequestPath.startsWith("/api/chat/media/outgoing/") ||
          (controlUiRouteBasePath.length > 0 &&
            scopedRequestPath.startsWith(`${controlUiRouteBasePath}/api/chat/media/outgoing/`)),
        async () =>
          (await getManagedMediaAttachmentsModule()).handleManagedOutgoingMediaHttpRequest(
            req,
            res,
            { ...routeAuth, basePath: controlUiRouteBasePath },
          ),
        false,
        "outgoing-media",
      );
      for (const [routes, loadHandler] of CONTROL_UI_IMAGE_HTTP_ROUTES) {
        addRequestStage(
          controlUiEnabled &&
            routes.some(
              (route) =>
                parseControlUiResourcePath(route, scopedRequestPath, controlUiRouteBasePath)
                  .matched,
            ),
          async () =>
            (await loadHandler())(req, res, {
              ...controlUiRouteOptions,
              sessionRowProjectionOwner:
                opts.getGatewayRequestContext?.()?.sessionRowProjectionOwner,
            }),
          false,
          "resource",
        );
      }
      // Authenticated media also serves non-browser clients when dashboard hosting is disabled.
      addRequestStage(
        scopedRequestPath === resolveAssistantMediaRoutePath(controlUiBasePath),
        async () =>
          (await loadControlUi())?.handleControlUiAssistantMediaRequest(req, res, {
            ...controlUiRouteOptions,
            agentId: resolveAssistantAgentId(configSnapshot),
          }) ?? false,
        false,
        "assistant-media",
      );
      addRequestStage(
        controlUiEnabled,
        async () =>
          (await loadControlUi())?.handleControlUiAvatarRequest(req, res, controlUiRouteOptions) ??
          false,
        false,
        "resource",
      );
      addRequestStage(controlUiEnabled, handleControlUiRequest, false, "document");

      // A completed or disconnected response owns the request even when a stage reports fallthrough.
      for (const stage of requestStages) {
        if (remoteIngress) {
          assertRemoteControlUiIngressCurrent(remoteIngress);
        }
        const handled = await stage();
        if (remoteIngress) {
          assertRemoteControlUiIngressCurrent(remoteIngress);
        }
        if (handled || res.destroyed || res.writableEnded) {
          return undefined;
        }
      }

      // Startup owns sidecar readiness. The plugin registry is still empty here, so an
      // unclaimed path may be a plugin route that would otherwise dead-end as a transient 404.
      if (opts.isStartupPluginRuntimeReady?.() === false) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "1");
        respondPlainText(res, 503, "Plugin runtime is starting");
        return undefined;
      }

      respondNotFound(res);
      return undefined;
    } catch (err) {
      if (finishGatewayHttpAuthorityError(res, err)) {
        return undefined;
      }
      console.error("[gateway-http] unhandled error in request handler:", err);
      finishFailedGatewayHttpResponse(res);
      return "failed";
    }
  }

  return Object.assign(handleServerRequest, { dispose: () => publicSessionRoute.dispose() });
}
