import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const CONTROL_PORT_ENV = "OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT";
const CONTROL_TOKEN_ENV = "OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN";
const TOKEN_HEADER = "x-openclaw-activation-token";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ACTIVATION_ID_BYTES = 256;
const CONTROL_HOST = "127.0.0.1";
const SIGNALS = ["SIGTERM", "SIGINT", "SIGUSR1"] as const;
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
  if (actual === undefined) return false;
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
    if (size > MAX_BODY_BYTES) throw new Error("activation body too large");
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
  const controlToken = env[CONTROL_TOKEN_ENV];

  if (controlPortValue === undefined && controlToken === undefined) {
    return { mode: "disabled" };
  }
  if (controlPortValue === undefined || controlToken === undefined) {
    throw new Error("control port and token must be configured together");
  }

  const controlPort = parseControlPort(controlPortValue);
  await params.preload?.();

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
      reject(error);
    };

    const cleanupSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      signalHandlers.clear();
    };

    const server = createServer((request, response) => {
      void handleRequest(request, response).catch((error) => {
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

    const closeServerAndReject = (error: Error) => {
      if (state === "settled") {
        return;
      }
      state = "closing";
      cleanupSignalHandlers();
      if (!server.listening) {
        activeServer = null;
        settleReject(error);
        return;
      }
      server.close((closeError) => {
        activeServer = null;
        settleReject(closeError ?? error);
      });
    };

    const handleSignal = (signal: ShutdownSignal) => {
      if (state !== "open") {
        return;
      }
      closeServerAndReject(new Error(`deferred activation interrupted by ${signal}`));
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
      const pathname = new URL(request.url ?? "/", `http://${CONTROL_HOST}`).pathname;

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

        state = "accepted";
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "accepted", activationId }), () => {
          cleanupSignalHandlers();
          server.close((error) => {
            activeServer = null;
            if (error) {
              settleReject(error);
            } else {
              settleResolve({ mode: "activated", activationId });
            }
          });
        });
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
  if (!server || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
