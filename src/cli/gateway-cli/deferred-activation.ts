import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  validateHeaderValue,
} from "node:http";

const CONTROL_PORT_ENV = "OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT";
const CONTROL_TOKEN_ENV = "OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN";
const TOKEN_HEADER = "x-openclaw-activation-token";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ACTIVATION_ID_BYTES = 256;
const CONTROL_HOST = "127.0.0.1";
const SIGNALS = ["SIGTERM", "SIGINT"] as const;
type ShutdownSignal = (typeof SIGNALS)[number];

type ProcessEnv = Record<string, string | undefined>;

export type DeferredActivationResult =
  | { mode: "disabled" }
  | { mode: "activated"; activationId: string };

export type DeferredActivationParams = {
  env?: ProcessEnv;
  preload?: () => Promise<void>;
};

let activeServer: Server | null = null;
let singleton: Promise<DeferredActivationResult> | null = null;

function tokensEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("activation body too large");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseActivationId(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("activation body must be an object");
  }
  const activationId = (value as { activationId?: unknown }).activationId;
  if (typeof activationId !== "string" || activationId.length === 0) {
    throw new Error("activationId must be a non-empty string");
  }
  if (Buffer.byteLength(activationId) > MAX_ACTIVATION_ID_BYTES) {
    throw new Error("activationId too large");
  }
  return activationId;
}

function parseControlToken(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error("invalid deferred activation control token");
  }
  try {
    validateHeaderValue(TOKEN_HEADER, value);
  } catch {
    throw new Error("invalid deferred activation control token");
  }
  return value;
}

function parseControlPort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("invalid deferred activation control port");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid deferred activation control port");
  }
  return port;
}

function drainRequest(request: IncomingMessage) {
  request.resume();
}

function normalizeServerCloseError(error: Error | null | undefined): Error | null {
  if (!error) {
    return null;
  }
  return (error as { code?: unknown }).code === "ERR_SERVER_NOT_RUNNING" ? null : error;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function waitForDeferredGatewayActivation(
  params: DeferredActivationParams = {},
): Promise<DeferredActivationResult> {
  singleton ??= waitForDeferredGatewayActivationOnce(params);
  return singleton;
}

async function waitForDeferredGatewayActivationOnce(
  params: DeferredActivationParams = {},
): Promise<DeferredActivationResult> {
  const env = params.env ?? process.env;
  const controlPortValue = env[CONTROL_PORT_ENV];
  const controlTokenValue = env[CONTROL_TOKEN_ENV];

  if (controlPortValue === undefined && controlTokenValue === undefined) {
    return { mode: "disabled" };
  }
  if (controlPortValue === undefined || controlTokenValue === undefined) {
    throw new Error("control port and token must be configured together");
  }

  const controlToken = parseControlToken(controlTokenValue);
  const controlPort = parseControlPort(controlPortValue);
  if (params.preload) {
    await params.preload();
  }

  return await new Promise<DeferredActivationResult>((resolve, reject) => {
    let state: "open" | "closing" | "accepted" | "settled" = "open";
    const signalHandlers = new Map<ShutdownSignal, () => void>();

    const settleResolve = (result: DeferredActivationResult) => {
      if (state === "settled") {
        return;
      }
      state = "settled";
      resolve(result);
    };

    const settleReject = (error: unknown) => {
      if (state === "settled") {
        return;
      }
      state = "settled";
      const reason = error instanceof Error ? error : new Error(String(error));
      reject(reason);
    };

    const cleanupSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      signalHandlers.clear();
    };

    const server = createServer((request, response) => {
      void handleRequest(request, response).catch((error: unknown) => {
        const reason = error instanceof Error ? error : new Error(String(error));
        if (!response.headersSent) {
          writeJson(response, 500, { error: "internal server error" });
        } else {
          response.destroy(reason);
        }
        closeServerAndReject(reason);
      });
    });
    activeServer = server;

    const closeServer = (onClosed: (error: Error | null) => void) => {
      // server.listen(...) is already issued before any parked signal/request path can
      // reach this helper, but Node may not flip server.listening yet. Always close so
      // shutdown cancels a pending bind instead of leaving the control port reserved.
      server.close((closeError) => {
        if (activeServer === server) {
          activeServer = null;
        }
        onClosed(normalizeServerCloseError(closeError ?? null));
      });
      server.closeAllConnections();
    };

    const closeServerAndResolve = (result: DeferredActivationResult) => {
      if (state !== "accepted") {
        return;
      }
      state = "closing";
      cleanupSignalHandlers();
      closeServer((closeError) => {
        if (closeError) {
          settleReject(closeError);
        } else {
          settleResolve(result);
        }
      });
    };

    const closeServerAndReject = (error: Error, resignal?: ShutdownSignal) => {
      if (state === "settled") {
        return;
      }
      state = "closing";
      cleanupSignalHandlers();
      closeServer((closeError) => {
        const finalError = closeError ?? error;
        if (resignal) {
          // Re-emit default-exit signals only after the parked listener is closed
          // so this helper does not turn a normal signal exit into code 1.
          try {
            process.kill(process.pid, resignal);
          } catch (killError) {
            const reason = killError instanceof Error ? killError : new Error(String(killError));
            settleReject(reason);
            return;
          }
        }
        settleReject(finalError);
      });
    };

    const handleSignal = (signal: ShutdownSignal) => {
      if (state !== "open") {
        return;
      }
      closeServerAndReject(new Error(`deferred activation interrupted by ${signal}`), signal);
    };

    for (const signal of SIGNALS) {
      const handler = () => handleSignal(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    server.once("close", () => {
      if (activeServer === server) {
        activeServer = null;
      }
      cleanupSignalHandlers();
    });

    server.once("error", (error) => {
      if (activeServer === server) {
        activeServer = null;
      }
      cleanupSignalHandlers();
      settleReject(error);
    });

    const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
      const method = request.method ?? "GET";
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", `http://${CONTROL_HOST}`).pathname;
      } catch {
        drainRequest(request);
        if (response.headersSent || response.writableEnded || response.destroyed) {
          response.destroy();
        } else {
          writeJson(response, 400, { error: "invalid request target" });
        }
        return;
      }

      if (pathname === "/healthz") {
        if (method !== "GET") {
          drainRequest(request);
          writeJson(response, 405, { error: "method not allowed" }, { allow: "GET" });
          return;
        }
        writeJson(response, 200, { status: "ok" });
        return;
      }

      if (pathname === "/readyz") {
        if (method !== "GET") {
          drainRequest(request);
          writeJson(response, 405, { error: "method not allowed" }, { allow: "GET" });
          return;
        }
        writeJson(response, 503, { status: "waiting" });
        return;
      }

      if (pathname !== "/activate") {
        drainRequest(request);
        writeJson(response, 404, { error: "not found" });
        return;
      }

      if (method !== "POST") {
        drainRequest(request);
        writeJson(response, 405, { error: "method not allowed" }, { allow: "POST" });
        return;
      }

      // Only one validated activation may win before the listener closes.
      if (state !== "open") {
        drainRequest(request);
        writeJson(response, 409, { error: "activation already accepted" });
        return;
      }

      const tokenHeader = request.headers[TOKEN_HEADER];
      const actualToken = typeof tokenHeader === "string" ? tokenHeader : undefined;
      if (!tokensEqual(actualToken, controlToken)) {
        drainRequest(request);
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      try {
        const body = await readBoundedJson(request);
        const activationId = parseActivationId(body);

        if (state !== "open") {
          writeJson(response, 409, { error: "activation already accepted" });
          return;
        }

        const acceptedResult: DeferredActivationResult = { mode: "activated", activationId };
        let activationCommitted = false;
        const commitAcceptedActivation = () => {
          if (activationCommitted) {
            return;
          }
          activationCommitted = true;
          response.removeListener("finish", commitAcceptedActivation);
          response.removeListener("close", commitAcceptedActivation);
          closeServerAndResolve(acceptedResult);
        };

        state = "accepted";
        // This accepted-state handoff is synchronous: restore default SIGTERM/SIGINT
        // semantics before any 202 write/end so bootstrap cannot swallow them.
        cleanupSignalHandlers();
        // A valid authenticated activation must still commit after the body is read
        // even if the client disappears before it can receive the best-effort 202.
        response.on("finish", commitAcceptedActivation);
        response.on("close", commitAcceptedActivation);
        if (response.destroyed) {
          commitAcceptedActivation();
          return;
        }

        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "accepted", activationId }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid activation request";
        const statusCode = message === "activation body too large" ? 413 : 400;
        writeJson(response, statusCode, {
          error: statusCode === 413 ? "activation body too large" : "invalid activation request",
        });
      }
    };

    server.listen(controlPort, CONTROL_HOST);
  });
}

export async function resetDeferredGatewayActivationForTest(): Promise<void> {
  const server = activeServer;
  activeServer = null;
  singleton = null;
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      const normalizedError = normalizeServerCloseError(error ?? null);
      if (normalizedError) {
        reject(normalizedError);
      } else {
        resolve();
      }
    });
    server.closeAllConnections();
  });
}
