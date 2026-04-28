import crypto from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { recordCliMessagingToolSend } from "../agents/cli-runner/messaging-tool-tracker.js";
import { isCoreMessageToolSendAction } from "../agents/messaging-tool-send-actions.js";
import { getRuntimeConfig } from "../config/io.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logDebug, logWarn } from "../logger.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";
import { jsonRpcError, type JsonRpcRequest } from "./mcp-http.protocol.js";
import {
  readMcpHttpBody,
  resolveMcpRequestContext,
  validateMcpLoopbackRequest,
  type McpRequestContext,
} from "./mcp-http.request.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";

export {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  resolveMcpLoopbackBearerToken,
} from "./mcp-http.loopback-runtime.js";

type McpLoopbackServer = {
  port: number;
  close: () => Promise<void>;
};

let activeMcpLoopbackServer: McpLoopbackServer | undefined;
let activeMcpLoopbackServerPromise: Promise<McpLoopbackServer> | null = null;

function shouldLogMcpLoopbackTraffic(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT) ||
    isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG)
  );
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  return normalizeOptionalString(record[key]);
}

function resolveMessageToolSentText(args: Record<string, unknown>): string | undefined {
  return (
    readStringField(args, "message") ??
    readStringField(args, "text") ??
    readStringField(args, "body") ??
    readStringField(args, "content")
  );
}

function pushMediaUrl(urls: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed || seen.has(trimmed)) {
    return;
  }
  seen.add(trimmed);
  urls.push(trimmed);
}

function resolveMessageToolSentMediaUrls(args: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  pushMediaUrl(urls, seen, args.media);
  pushMediaUrl(urls, seen, args.mediaUrl);
  pushMediaUrl(urls, seen, args.path);
  pushMediaUrl(urls, seen, args.filePath);
  if (Array.isArray(args.mediaUrls)) {
    for (const mediaUrl of args.mediaUrls) {
      pushMediaUrl(urls, seen, mediaUrl);
    }
  }
  return urls;
}

function responseHasLogicalToolFailure(response: object): boolean {
  if (!isRecord(response) || !isRecord(response.result)) {
    return false;
  }
  const content = response.result.content;
  if (!Array.isArray(content)) {
    return false;
  }
  for (const block of content) {
    if (!isRecord(block) || typeof block.text !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(block.text) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const status = readStringField(parsed, "status");
      if (status === "error" || status === "forbidden" || status === "timeout") {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function recordMcpMessagingToolSend(params: {
  requestContext: McpRequestContext;
  toolName?: string;
  args: Record<string, unknown>;
  isError: boolean;
}): void {
  if (params.isError || (params.toolName !== "message" && params.toolName !== "sessions_send")) {
    return;
  }
  if (params.toolName === "sessions_send") {
    return;
  }
  if (params.args.dryRun === true) {
    return;
  }
  const action = readStringField(params.args, "action") ?? "send";
  if (!isCoreMessageToolSendAction(action)) {
    return;
  }
  const provider =
    readStringField(params.args, "provider") ??
    readStringField(params.args, "channel") ??
    params.requestContext.messageProvider ??
    "message";
  const to =
    readStringField(params.args, "to") ??
    readStringField(params.args, "target") ??
    params.requestContext.currentChannelId ??
    params.requestContext.agentTo;
  const accountId = readStringField(params.args, "accountId") ?? params.requestContext.accountId;
  const threadId = readStringField(params.args, "threadId") ?? params.requestContext.agentThreadId;
  recordCliMessagingToolSend({
    sessionKey: params.requestContext.sessionKey,
    runId: params.requestContext.runId,
    target: {
      tool: params.toolName,
      provider,
      ...(accountId ? { accountId } : {}),
      ...(to ? { to } : {}),
      ...(threadId ? { threadId } : {}),
    },
    text: resolveMessageToolSentText(params.args),
    mediaUrls: resolveMessageToolSentMediaUrls(params.args),
  });
}

function logMcpLoopbackTraffic(step: string, details: Record<string, unknown>): void {
  if (!shouldLogMcpLoopbackTraffic()) {
    return;
  }
  console.error(`[mcp-loopback] ${step} ${JSON.stringify(details)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRequestAbortSignal(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const abortIfRequestIncomplete = () => {
    if (!req.complete) {
      abort();
    }
  };
  const abortIfResponseStillOpen = () => {
    if (!res.writableEnded) {
      abort();
    }
  };
  req.once("close", abortIfRequestIncomplete);
  res.once("close", abortIfResponseStillOpen);
  if (req.destroyed && !req.complete) {
    abort();
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("close", abortIfRequestIncomplete);
      res.off("close", abortIfResponseStillOpen);
    },
  };
}

export async function startMcpLoopbackServer(port = 0): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const nonOwnerToken = crypto.randomBytes(32).toString("hex");
  const toolCache = new McpLoopbackToolCache();

  const httpServer = createHttpServer((req, res) => {
    const auth = validateMcpLoopbackRequest({ req, res, ownerToken, nonOwnerToken });
    if (!auth) {
      return;
    }

    const requestAbort = createRequestAbortSignal(req, res);
    void (async () => {
      try {
        const body = await readMcpHttpBody(req);
        const parsed: JsonRpcRequest | JsonRpcRequest[] = JSON.parse(body);
        const cfg = getRuntimeConfig();
        const requestContext = resolveMcpRequestContext(req, cfg, auth);
        const scopedTools = toolCache.resolve({
          cfg,
          sessionKey: requestContext.sessionKey,
          messageProvider: requestContext.messageProvider,
          accountId: requestContext.accountId,
          agentTo: requestContext.agentTo,
          agentThreadId: requestContext.agentThreadId,
          currentChannelId: requestContext.currentChannelId,
          senderIsOwner: requestContext.senderIsOwner,
        });

        const messages = Array.isArray(parsed) ? parsed : [parsed];
        logMcpLoopbackTraffic("request", {
          batchSize: messages.length,
          methods: messages.map((message) => message.method),
          sessionKey: requestContext.sessionKey,
          senderIsOwner: requestContext.senderIsOwner,
          toolCount: scopedTools.toolSchema.length,
          cronVisible: scopedTools.toolSchema.some((tool) => tool.name === "cron"),
        });
        const responses: object[] = [];
        for (const message of messages) {
          const response = await handleMcpJsonRpc({
            message,
            tools: scopedTools.tools,
            toolSchema: scopedTools.toolSchema,
            hookContext: {
              agentId: scopedTools.agentId,
              sessionKey: requestContext.sessionKey,
            },
            signal: requestAbort.signal,
          });
          if (response !== null) {
            const toolName =
              message.method === "tools/call" && isRecord(message.params)
                ? message.params.name
                : undefined;
            const toolArgs =
              message.method === "tools/call" &&
              isRecord(message.params) &&
              isRecord(message.params.arguments)
                ? message.params.arguments
                : {};
            const isError =
              isRecord(response) && isRecord(response.result) && response.result.isError === true;
            const hasLogicalFailure =
              typeof toolName === "string" && toolName === "sessions_send"
                ? responseHasLogicalToolFailure(response)
                : false;
            recordMcpMessagingToolSend({
              requestContext,
              toolName: typeof toolName === "string" ? toolName : undefined,
              args: toolArgs,
              isError: isError || hasLogicalFailure,
            });
            logMcpLoopbackTraffic("response", {
              method: message.method,
              toolName: typeof toolName === "string" ? toolName : undefined,
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(payload);
      } catch (error) {
        logWarn(`mcp loopback: request handling failed: ${formatErrorMessage(error)}`);
        logMcpLoopbackTraffic("request-failed", {
          message: formatErrorMessage(error),
        });
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
        }
      } finally {
        requestAbort.cleanup();
      }
    })();
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
  setActiveMcpLoopbackRuntime({ port: address.port, ownerToken, nonOwnerToken });
  logDebug(`mcp loopback listening on 127.0.0.1:${address.port}`);

  const server: McpLoopbackServer = {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (!error) {
            clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
            if (activeMcpLoopbackServer === server) {
              activeMcpLoopbackServer = undefined;
            }
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
  return server;
}

export async function ensureMcpLoopbackServer(port = 0): Promise<McpLoopbackServer> {
  if (activeMcpLoopbackServer) {
    return activeMcpLoopbackServer;
  }
  if (!activeMcpLoopbackServerPromise) {
    activeMcpLoopbackServerPromise = startMcpLoopbackServer(port)
      .then((server) => {
        activeMcpLoopbackServer = server;
        return server;
      })
      .finally(() => {
        activeMcpLoopbackServerPromise = null;
      });
  }
  return activeMcpLoopbackServerPromise;
}

export async function closeMcpLoopbackServer(): Promise<void> {
  const server =
    activeMcpLoopbackServer ??
    (activeMcpLoopbackServerPromise ? await activeMcpLoopbackServerPromise : undefined);
  if (!server) {
    return;
  }
  activeMcpLoopbackServer = undefined;
  await server.close();
}
