import crypto from "node:crypto";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withAgentQuestionAnswerAuthority } from "../agents/harness/host-private-capabilities.js";
import { acknowledgeInternalToolResult } from "../agents/runtime/internal-hooks.js";
import { resolveToolLoopDetectionConfig } from "../agents/tool-loop-detection-config.js";
import { isAutomationsToolName } from "../agents/tools/automations-tool-name.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionEntryAccessTarget } from "../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isRequestBodyLimitError, readRequestBodyWithLimit } from "../infra/http-body.js";
import {
  createHttpRequestAbortSignal,
  sendHttpRequestRejection,
} from "../infra/http-request-lifecycle.js";
import { logDebug, logWarn } from "../logger.js";
import { runOutsidePluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionStoreEntryProtected,
} from "../sessions/agent-harness-session-key.js";
import { AsyncWorkScope, runWithTrackedCancellation } from "../shared/async-work-scope.js";
import {
  registerMcpLoopbackClientGrantRevocationListener,
  revokeMcpLoopbackClientGrantsForRuntime,
} from "./mcp-grant-store.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  getActiveMcpLoopbackRuntime,
  markMcpLoopbackRequestClassified,
  markMcpLoopbackRequestFinished,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  resolveMcpLoopbackYieldContext,
  setActiveMcpLoopbackRuntime,
  updateMcpLoopbackToolCallCapture,
} from "./mcp-http.loopback-runtime.js";
import { jsonRpcError, type JsonRpcRequest } from "./mcp-http.protocol.js";
import {
  logMcpLoopbackTraffic,
  resolveMcpCliCaptureKey,
  resolveMcpHttpBodyTimeoutMs,
  resolveMcpRequestContext,
  validateMcpLoopbackRequest,
} from "./mcp-http.request.js";

// Loopback MCP server exposes gateway-scoped tools to local MCP clients over a
// bearer-token HTTP endpoint bound to 127.0.0.1. Only one active server/runtime
// is registered per process.

const MAX_MCP_BODY_BYTES = 1_048_576;
const MCP_HTTP_KEEPALIVE_MS = 15_000;

function keepMcpResponseAlive(res: ServerResponse, contentType: string, frame: string): () => void {
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded || res.writableNeedDrain) {
      return;
    }
    if (!res.headersSent) {
      res.writeHead(200, { "Content-Type": contentType });
    }
    res.write(frame);
  }, MCP_HTTP_KEEPALIVE_MS);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    res.off("close", stop);
    res.off("finish", stop);
  };
  res.once("close", stop);
  res.once("finish", stop);
  return stop;
}

let closeActiveMcpLoopbackServer: (() => Promise<void>) | undefined;
let activeMcpLoopbackServerPromise: Promise<void> | null = null;

function parseMcpJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw Object.assign(new Error("MCP JSON parse error"), {
      cause: error,
      code: "mcp_json_parse_error",
    });
  }
}

function readJsonRpcRequestId(message: unknown) {
  if (!isRecord(message)) {
    return null;
  }
  const id = message.id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return isRecord(message) && message.jsonrpc === "2.0" && typeof message.method === "string";
}

function shouldSendJsonRpcResponse(message: unknown): boolean {
  return !isJsonRpcRequest(message) || Object.hasOwn(message, "id");
}

function collectJsonRpcResponses<T>(
  messages: unknown[],
  createResponse: (message: unknown) => T,
): T[] {
  return messages.filter(shouldSendJsonRpcResponse).map(createResponse);
}

function jsonRpcInternalError(parsed: unknown) {
  const isBatch = Array.isArray(parsed);
  const messages = isBatch ? parsed : [parsed];
  const responses = collectJsonRpcResponses(messages, (message) =>
    jsonRpcError(readJsonRpcRequestId(message), -32603, "Internal error"),
  );
  if (responses.length === 0) {
    return null;
  }
  return isBatch ? responses : responses[0];
}

/** Starts a new MCP loopback HTTP server and registers its bearer tokens. */
async function startMcpLoopbackServer(
  port: number,
  work: AsyncWorkScope,
): Promise<() => Promise<void>> {
  // Shutdown preloads this module even when no MCP listener is needed.
  const [{ handleMcpJsonRpc }, { McpLoopbackToolCache }] = await Promise.all([
    import("./mcp-http.handlers.js"),
    import("./mcp-http.runtime.js"),
  ]);
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const nonOwnerToken = crypto.randomBytes(32).toString("hex");
  const toolCache = new McpLoopbackToolCache();
  // GET notification streams are intentionally long-lived; shutdown must end
  // them itself before waiting for httpServer.close() to drain active responses.
  const activeSseResponses = new Set<ServerResponse>();

  const trackSseResponse = (res: ServerResponse): void => {
    activeSseResponses.add(res);
    keepMcpResponseAlive(res, "text/event-stream", ":\n\n");
    const cleanup = () => {
      activeSseResponses.delete(res);
      res.off("close", cleanup);
      res.off("finish", cleanup);
    };
    res.once("close", cleanup);
    res.once("finish", cleanup);
  };

  const closeActiveSseResponses = (): void => {
    for (const res of activeSseResponses) {
      if (!res.destroyed && !res.writableEnded) {
        const socket = res.socket;
        res.end();
        socket?.end();
      }
    }
  };

  const httpServer = createHttpServer((req, res) => {
    const auth = validateMcpLoopbackRequest({
      req,
      res,
      ownerToken,
      nonOwnerToken,
      onSseResponse: trackSseResponse,
    });
    if (!auth) {
      return;
    }

    // Bind the request before body parsing/tool resolution. A CLI may exit while
    // an accepted request is still uploading, and retries must not outrun it.
    const cliCaptureKey = resolveMcpCliCaptureKey(req, auth);
    const cliRequestCaptureHandle = markMcpLoopbackRequestStarted(cliCaptureKey);
    const requestAbort = createHttpRequestAbortSignal(req, res);
    void work.track(async () => {
      let parsed: unknown;
      let stopKeepalive: (() => void) | undefined;
      let cliCaptureHandles: Array<ReturnType<typeof markMcpLoopbackToolCallStarted>> = [];
      try {
        const body = await readRequestBodyWithLimit(req, {
          maxBytes: MAX_MCP_BODY_BYTES,
          timeoutMs: resolveMcpHttpBodyTimeoutMs(),
          destroyOnLimit: false,
        });
        parsed = parseMcpJsonBody(body);
        if (Array.isArray(parsed) && parsed.length === 0) {
          markMcpLoopbackRequestClassified(cliRequestCaptureHandle);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcError(null, -32600, "Invalid Request")));
          return;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        cliCaptureHandles = messages.map((message) => {
          if (
            !cliRequestCaptureHandle ||
            !isJsonRpcRequest(message) ||
            message.method !== "tools/call"
          ) {
            return undefined;
          }
          const admittedToolName =
            isRecord(message.params) && typeof message.params.name === "string"
              ? message.params.name
              : "";
          const toolArgs =
            isRecord(message.params) && isRecord(message.params.arguments)
              ? message.params.arguments
              : {};
          return markMcpLoopbackToolCallStarted({
            requestCaptureHandle: cliRequestCaptureHandle,
            toolName: admittedToolName,
            args: toolArgs,
          });
        });
        markMcpLoopbackRequestClassified(cliRequestCaptureHandle);
        const { boundGrantToken, boundClientGrant } = auth;
        if (boundClientGrant && !boundClientGrant.isCurrent()) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const cfg = getRuntimeConfig();
        const requestContext = resolveMcpRequestContext(req, cfg, auth);
        const authorizeToolCall = () =>
          !work.isClosing &&
          getActiveMcpLoopbackRuntime()?.ownerToken === ownerToken &&
          (boundClientGrant?.isCurrent() ?? true);
        const harnessEntry = isAgentHarnessSessionKey(requestContext.sessionKey)
          ? resolveSessionEntryAccessTarget({ cfg, sessionKey: requestContext.sessionKey }).entry
          : undefined;
        if (
          isAgentHarnessSessionKey(requestContext.sessionKey) &&
          (!harnessEntry ||
            isAgentHarnessSessionStoreEntryProtected(requestContext.sessionKey, harnessEntry))
        ) {
          const errors = collectJsonRpcResponses(messages, (message) =>
            jsonRpcError(
              readJsonRpcRequestId(message),
              -32600,
              AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
            ),
          );
          if (errors.length === 0) {
            res.writeHead(202);
            res.end();
            return;
          }
          const payload = Array.isArray(parsed)
            ? JSON.stringify(errors)
            : JSON.stringify(errors[0]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(payload);
          return;
        }
        const yieldContext = resolveMcpLoopbackYieldContext(cliRequestCaptureHandle);
        // Tools capture their creator at construction, not the later HTTP execution scope.
        const scopedTools = await withAgentQuestionAnswerAuthority(
          boundClientGrant?.questionAnswerAuthority,
          () =>
            toolCache.resolve({
              context: requestContext,
              rootedExecution: boundClientGrant?.rootedExecution,
              messageActionTurnCapability: boundClientGrant?.messageActionTurnCapability,
              cfg,
              signal: requestAbort.signal,
              ...(boundClientGrant?.toolAuth
                ? {
                    authProfileStore: boundClientGrant.toolAuth.store,
                    ...(boundClientGrant.toolAuth.agentDir
                      ? { authProfileStoreAgentDir: boundClientGrant.toolAuth.agentDir }
                      : {}),
                  }
                : {}),
              ...(boundGrantToken ? { grantToken: boundGrantToken } : {}),
              // Same liveness check `authorizeToolCall` applies after the hook,
              // handed to run-contract tools so a revocation that lands while a
              // call is in flight also fails the durable write.
              isGrantCurrent: authorizeToolCall,
              yieldContextCacheKey: yieldContext?.cacheKey,
              onYield: yieldContext?.onYield,
              ...(boundClientGrant?.skillLibraryAuthoring
                ? { skillLibraryAuthoring: boundClientGrant.skillLibraryAuthoring }
                : {}),
            }),
        );

        // Discovery may outlive the requesting connection or grant.
        requestAbort.signal.throwIfAborted();
        if (boundClientGrant && !boundClientGrant.isCurrent()) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        logMcpLoopbackTraffic("request", {
          batchSize: messages.length,
          methods: messages.map((message) =>
            isJsonRpcRequest(message) ? message.method : undefined,
          ),
          sessionKey: requestContext.sessionKey,
          inboundEventKind: requestContext.inboundEventKind,
          senderIsOwner: requestContext.senderIsOwner,
          toolCount: scopedTools.toolSchema.length,
          cronVisible: scopedTools.toolSchema.some((tool) => isAutomationsToolName(tool.name)),
        });
        // Keep the existing single JSON response: leading whitespace prevents
        // HTTP header/body idle timeouts without completing or replaying the tool.
        // Notifications still receive an empty 202, so they must not start a body.
        if (messages.some(shouldSendJsonRpcResponse)) {
          stopKeepalive = keepMcpResponseAlive(res, "application/json", "\n");
        }
        const responses: object[] = [];
        for (const [messageIndex, message] of messages.entries()) {
          if (!isJsonRpcRequest(message)) {
            responses.push(jsonRpcError(readJsonRpcRequestId(message), -32600, "Invalid Request"));
            continue;
          }
          if (
            message.method === "tools/call" &&
            requestContext.nativeCronCreatorToolAllowlist === null
          ) {
            if (shouldSendJsonRpcResponse(message)) {
              responses.push(
                jsonRpcError(
                  readJsonRpcRequestId(message),
                  -32000,
                  "Native tool authority is not initialized. Retry after native startup, or start a fresh session; no tool action was taken.",
                ),
              );
            }
            continue;
          }
          const cliCaptureHandle = cliCaptureHandles[messageIndex];
          let response: object | null;
          try {
            const handleRequest = async (signal: AbortSignal) =>
              await handleMcpJsonRpc({
                message,
                tools: scopedTools.tools,
                toolSchema: scopedTools.toolSchema,
                hookContext: {
                  agentId: scopedTools.agentId,
                  config: cfg,
                  ...(scopedTools.workspaceDir ? { workspaceDir: scopedTools.workspaceDir } : {}),
                  sessionKey: requestContext.sessionKey,
                  sessionId: requestContext.sessionId,
                  runId: requestContext.runId,
                  approvalReviewerDeviceId: requestContext.approvalReviewerDeviceId,
                  channelId: requestContext.currentChannelId,
                  turnSourceChannel: requestContext.messageProvider,
                  turnSourceTo: requestContext.currentChannelId,
                  turnSourceAccountId: requestContext.accountId,
                  turnSourceThreadId: requestContext.currentThreadTs,
                  loopDetection: resolveToolLoopDetectionConfig({
                    cfg,
                    agentId: scopedTools.agentId,
                  }),
                },
                signal,
                authorizeToolCall,
                onToolCallPrepared: cliCaptureHandle
                  ? ({ toolName: preparedToolName, args }) => {
                      updateMcpLoopbackToolCallCapture(cliCaptureHandle, {
                        toolName: preparedToolName,
                        args,
                      });
                    }
                  : undefined,
                onToolCallResult: cliCaptureHandle
                  ? (result) => {
                      recordMcpLoopbackToolCallResult({
                        captureHandle: cliCaptureHandle,
                        ...result,
                      });
                    }
                  : undefined,
              });
            const callerIdentity = boundClientGrant
              ? createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext: boundClientGrant.admittedRunContext,
                  receiptAuthority: boundClientGrant.isCurrent,
                  cronAuthorityCheck: boundClientGrant.cronAuthorityCheck,
                  mintCronRequesterGrant: boundClientGrant.mintCronRequesterGrant,
                  agentId: scopedTools.agentId,
                  sessionKey: requestContext.sessionKey,
                  turnSourceChannel: requestContext.messageProvider,
                  turnSourceLocal:
                    !requestContext.messageProvider &&
                    requestContext.cronCreatorCallerOrigin?.kind === "local"
                      ? true
                      : undefined,
                  turnSourceTo: requestContext.currentChannelId,
                  turnSourceAccountId: requestContext.accountId,
                  turnSourceThreadId: requestContext.currentThreadTs,
                })
              : undefined;
            response = await withGatewayToolCallerIdentity(callerIdentity, () =>
              runWithTrackedCancellation(requestAbort.signal, handleRequest),
            );
          } finally {
            markMcpLoopbackToolCallFinished(cliCaptureHandle);
          }
          if (response !== null && shouldSendJsonRpcResponse(message)) {
            const responseToolName =
              message.method === "tools/call" && isRecord(message.params)
                ? message.params.name
                : undefined;
            const isError =
              isRecord(response) && isRecord(response.result) && response.result.isError === true;
            logMcpLoopbackTraffic("response", {
              method: message.method,
              toolName: typeof responseToolName === "string" ? responseToolName : undefined,
              isError,
            });
            responses.push(response);
          }
        }

        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }

        const payload = Array.isArray(parsed)
          ? JSON.stringify(responses)
          : JSON.stringify(responses[0]);
        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "application/json" });
        }
        res.end(payload, () => {
          // Ending queues bytes; only a completed write owns result delivery.
          if (res.writableFinished) {
            responses.forEach(acknowledgeInternalToolResult);
          }
        });
      } catch (error) {
        const message = isRequestBodyLimitError(error)
          ? {
              PAYLOAD_TOO_LARGE: `Request body exceeds ${MAX_MCP_BODY_BYTES} bytes`,
              REQUEST_BODY_TIMEOUT: "Request body timed out",
              CONNECTION_CLOSED: "Request body connection closed",
            }[error.code]
          : formatErrorMessage(error);
        logWarn(`mcp-loopback: request handling failed: ${message}`);
        logMcpLoopbackTraffic("request-failed", { message });
        if (res.headersSent && !res.destroyed && !res.writableEnded) {
          res.end(JSON.stringify(jsonRpcInternalError(parsed)));
        } else if (!res.headersSent) {
          // Capture settles when rejection is queued; the transport owner joins socket cleanup.
          if (
            isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE") ||
            isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")
          ) {
            const tooLarge = error.code === "PAYLOAD_TOO_LARGE";
            void sendHttpRequestRejection(
              req,
              res,
              tooLarge ? 413 : 408,
              JSON.stringify({ error: tooLarge ? "payload_too_large" : "request_body_timeout" }),
              "application/json",
            );
          } else if (isRecord(error) && error.code === "mcp_json_parse_error") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
          } else {
            const internalError = jsonRpcInternalError(parsed);
            if (internalError === null) {
              res.writeHead(202);
              res.end();
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify(internalError));
            }
          }
        }
      } finally {
        stopKeepalive?.();
        requestAbort.cleanup();
        for (const captureHandle of cliCaptureHandles) {
          markMcpLoopbackToolCallFinished(captureHandle);
        }
        markMcpLoopbackRequestFinished(cliRequestCaptureHandle);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("mcp loopback did not bind to a TCP port");
  }
  const unregisterGrantRevocation = registerMcpLoopbackClientGrantRevocationListener((event) => {
    if (event.runtimeOwnerToken === ownerToken) {
      toolCache.evictGrant(event.token);
    }
  });
  // Register tokens only after the TCP listener is live so clients never learn
  // a bearer token for a server that failed to bind.
  setActiveMcpLoopbackRuntime({ port: address.port, ownerToken, nonOwnerToken });
  logDebug(`mcp loopback listening on 127.0.0.1:${address.port}`);

  return async () => {
    // Stop admitting this runtime's child grants before draining accepted
    // requests. A delayed old-server close cannot revoke a successor runtime.
    clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
    revokeMcpLoopbackClientGrantsForRuntime(ownerToken);
    unregisterGrantRevocation();
    toolCache.clear();
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        closeActiveSseResponses();
      });
    } finally {
      await work.drain();
    }
  };
}

/** Waits for the process-owned MCP loopback server, starting one if needed. */
export async function ensureMcpLoopbackServer(port = 0): Promise<void> {
  if (closeActiveMcpLoopbackServer) {
    return;
  }
  if (!activeMcpLoopbackServerPromise) {
    // The listener owns its context until Gateway close; callers own only requests.
    // The first turn's work and plugin generation can retire before later requests.
    const work = new AsyncWorkScope();
    activeMcpLoopbackServerPromise = runOutsidePluginRuntimeGenerationScope(() =>
      runOutsideGatewayRootWorkAdmission(() => work.run(() => startMcpLoopbackServer(port, work))),
    )
      .then((close) => {
        closeActiveMcpLoopbackServer = close;
      })
      .catch(async (error: unknown) => {
        await work.drain();
        throw error;
      })
      .finally(() => {
        activeMcpLoopbackServerPromise = null;
      });
  }
  return activeMcpLoopbackServerPromise;
}

/** Closes the active MCP loopback server if one has been started. */
export async function closeMcpLoopbackServer(): Promise<void> {
  if (activeMcpLoopbackServerPromise) {
    await activeMcpLoopbackServerPromise;
  }
  // Claim after startup so concurrent shutdown waiters cannot close the same
  // listener twice. A later call owns only the then-current server, not drains.
  const close = closeActiveMcpLoopbackServer;
  closeActiveMcpLoopbackServer = undefined;
  await close?.();
}
