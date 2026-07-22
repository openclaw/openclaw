import type {
  ExecutionAcceptedResponse,
  ReviewAcceptedResponse,
  StartExecutionCommand,
  StartReviewCommand,
} from "@openclaw/contracts";
import { assertPlatformContract } from "./contracts-runtime.js";
import type {
  ExecutionOutcome,
  ExecutionPort,
  ReviewOutcome,
  ReviewPort,
} from "./platform-job-ports.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

type LoopbackClientOptions = {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly requestTimeoutMs?: number;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

type ServerEvent = {
  readonly id: number;
  readonly type: string;
  readonly data: unknown;
};

function parseLoopbackOrigin(value: string): URL {
  const url = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("platform service URL must be a bare HTTP loopback origin");
  }
  return url;
}

function parseServerEvents(body: string): ServerEvent[] {
  return body
    .split(/\r?\n\r?\n/u)
    .filter(Boolean)
    .map((block) => {
      const fields = new Map(
        block.split(/\r?\n/u).map((line) => {
          const separator = line.indexOf(":");
          return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
        }),
      );
      const id = Number(fields.get("id"));
      const type = fields.get("event");
      const data = fields.get("data");
      if (!Number.isSafeInteger(id) || !type || data === undefined) {
        throw new Error("platform service returned an invalid event stream");
      }
      return { id, type, data: JSON.parse(data) as unknown };
    });
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("platform service response exceeded the size limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

class LoopbackPlatformClient {
  readonly #origin: URL;
  readonly #bearerToken: string;
  readonly #requestTimeoutMs: number;
  readonly #waitTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: LoopbackClientOptions) {
    this.#origin = parseLoopbackOrigin(options.baseUrl);
    if (!options.bearerToken.trim()) {
      throw new Error("platform service bearer token is required");
    }
    this.#bearerToken = options.bearerToken;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#waitTimeoutMs = options.waitTimeoutMs ?? 15 * 60_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  async post(pathname: string, body: unknown, idempotencyKey: string): Promise<unknown> {
    return await this.#request(pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  }

  async waitForEvent(pathname: string, terminalTypes: ReadonlySet<string>): Promise<ServerEvent> {
    const deadline = Date.now() + this.#waitTimeoutMs;
    let cursor = 0;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const body = await this.#requestText(pathname, {
        method: "GET",
        headers: cursor > 0 ? { "last-event-id": String(cursor) } : undefined,
        timeoutMs: Math.min(this.#requestTimeoutMs, remaining),
      });
      for (const event of parseServerEvents(body)) {
        cursor = Math.max(cursor, event.id);
        if (terminalTypes.has(event.type)) {
          return event;
        }
      }
      await this.#sleep(Math.min(this.#pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error("platform service wait timed out");
  }

  async #request(pathname: string, init: RequestInit): Promise<unknown> {
    const body = await this.#requestText(pathname, { ...init, timeoutMs: this.#requestTimeoutMs });
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("platform service returned invalid JSON");
    }
  }

  async #requestText(
    pathname: string,
    init: RequestInit & { readonly timeoutMs: number },
  ): Promise<string> {
    const { timeoutMs, ...requestInit } = init;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#bearerToken}`);
    let response: Response;
    try {
      response = await this.#fetch(new URL(pathname, this.#origin), {
        ...requestInit,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("platform service request failed");
    }
    if (!response.ok) {
      throw new Error(`platform service request failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error("platform service response exceeded the size limit");
    }
    return await readBoundedResponseBody(response);
  }
}

export class LoopbackPiExecutionAdapter implements ExecutionPort {
  readonly #client: LoopbackPlatformClient;

  constructor(options: LoopbackClientOptions) {
    this.#client = new LoopbackPlatformClient(options);
  }

  async start(
    command: StartExecutionCommand,
    idempotencyKey: string,
  ): Promise<ExecutionAcceptedResponse> {
    const value = await this.#client.post("/v1/executions", command, idempotencyKey);
    return assertPlatformContract("ExecutionAcceptedResponse", value);
  }

  async wait(executionId: string): Promise<ExecutionOutcome> {
    const event = await this.#client.waitForEvent(
      `/v1/executions/${encodeURIComponent(executionId)}/events`,
      new Set(["execution_completed", "execution_failed"]),
    );
    if (event.type === "execution_completed") {
      return assertPlatformContract("ExecutionCompletedEvent", event.data);
    }
    return assertPlatformContract("ExecutionFailedEvent", event.data);
  }
}

export class LoopbackReviewAdapter implements ReviewPort {
  readonly #client: LoopbackPlatformClient;

  constructor(options: LoopbackClientOptions) {
    this.#client = new LoopbackPlatformClient(options);
  }

  async start(
    command: StartReviewCommand,
    idempotencyKey: string,
  ): Promise<ReviewAcceptedResponse> {
    const value = await this.#client.post("/v1/reviews", command, idempotencyKey);
    return assertPlatformContract("ReviewAcceptedResponse", value);
  }

  async wait(reviewId: string): Promise<ReviewOutcome> {
    const event = await this.#client.waitForEvent(
      `/v1/reviews/${encodeURIComponent(reviewId)}/events`,
      new Set(["review_completed", "review_failed", "review_cancelled"]),
    );
    if (event.type === "review_completed") {
      return assertPlatformContract("ReviewCompletedEvent", event.data);
    }
    return {
      status: event.type === "review_cancelled" ? "cancelled" : "failed",
      review_id: reviewId,
    };
  }
}
