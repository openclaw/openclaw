export type CliThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export type BenchCloudBridgeConfig = {
  enabled: boolean;
  apiBaseUrl: string;
  instanceId?: string;
  installId?: string;
  agentIdAliases: Record<string, string>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
};

export type BenchCloudCliTurnRequest = {
  instanceId: string;
  installId?: string;
  agentId: string;
  sessionKey: string;
  runId: string;
  idempotencyKey: string;
  message: string;
  thinkingLevel?: CliThinkingLevel;
  attachmentCount?: number;
};

export type BenchCloudCliTurnCreateResponse =
  | {
      dispatch: "local";
      runtime: "local" | null;
    }
  | {
      dispatch: "remote-brain";
      runtime: "remote-brain";
      cloudTurnId: string;
      directiveId: string;
      statusUrl: string;
      status: string;
      runId: string;
      agentId: string;
      instanceId: string;
    };

export type BenchCloudCliTurnNonCompletedStatus =
  | "pending-approval"
  | "pending"
  | "leased"
  | "in-progress"
  | "failed"
  | "rejected"
  | "expired"
  | "revoked";

export type BenchCloudCliTurnStatusResponse =
  | {
      status: "completed";
      directiveId: string;
      runId: string;
      agentId: string;
      instanceId: string;
      responseText: string;
      stopReason?: string;
      usedAuthProfile?: string;
      resultRaw?: unknown;
    }
  | {
      status: BenchCloudCliTurnNonCompletedStatus;
      directiveId: string;
      runId: string;
      agentId: string;
      instanceId: string;
      error?: { code?: string; message?: string };
    };

export class BenchCloudBridgeError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, opts?: { status?: number; code?: string }) {
    super(message);
    this.name = "BenchCloudBridgeError";
    this.status = opts?.status;
    this.code = opts?.code;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveUrl(config: BenchCloudBridgeConfig, pathOrUrl: string): string {
  return new URL(pathOrUrl, `${trimTrailingSlash(config.apiBaseUrl)}/`).toString();
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BenchCloudBridgeError("Bench cloud returned invalid JSON", {
      status: response.status,
    });
  }
}

function errorMessageFromBody(body: unknown, fallback: string): { message: string; code?: string } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = typeof record.error === "string" ? record.error : fallback;
    const code = typeof record.code === "string" ? record.code : undefined;
    return { message, code };
  }
  return { message: fallback };
}

function assertTurnCreateResponse(body: unknown): BenchCloudCliTurnCreateResponse {
  if (!body || typeof body !== "object") {
    throw new BenchCloudBridgeError("Bench cloud returned an empty turn response");
  }
  const record = body as Record<string, unknown>;
  if (record.dispatch === "local") {
    return {
      dispatch: "local",
      runtime: record.runtime === "local" ? "local" : null,
    };
  }
  if (
    record.dispatch === "remote-brain" &&
    record.runtime === "remote-brain" &&
    typeof record.directiveId === "string" &&
    typeof record.statusUrl === "string"
  ) {
    return record as BenchCloudCliTurnCreateResponse;
  }
  throw new BenchCloudBridgeError("Bench cloud returned an invalid turn response");
}

function assertTurnStatusResponse(body: unknown): BenchCloudCliTurnStatusResponse {
  if (!body || typeof body !== "object") {
    throw new BenchCloudBridgeError("Bench cloud returned an empty turn status");
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.status === "string" &&
    typeof record.directiveId === "string" &&
    typeof record.runId === "string" &&
    typeof record.agentId === "string" &&
    typeof record.instanceId === "string"
  ) {
    return record as BenchCloudCliTurnStatusResponse;
  }
  throw new BenchCloudBridgeError("Bench cloud returned an invalid turn status");
}

export async function createBenchCloudCliTurn(params: {
  config: BenchCloudBridgeConfig;
  authToken: string;
  body: BenchCloudCliTurnRequest;
  signal?: AbortSignal;
}): Promise<BenchCloudCliTurnCreateResponse> {
  const response = await fetch(resolveUrl(params.config, "/api/v1/cli/cloud-brain/turns"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.body),
    signal: params.signal,
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    const error = errorMessageFromBody(body, `Bench cloud returned HTTP ${response.status}`);
    throw new BenchCloudBridgeError(error.message, {
      status: response.status,
      code: error.code,
    });
  }
  return assertTurnCreateResponse(body);
}

export async function readBenchCloudCliTurnStatus(params: {
  config: BenchCloudBridgeConfig;
  authToken: string;
  statusUrl: string;
  signal?: AbortSignal;
}): Promise<BenchCloudCliTurnStatusResponse> {
  const response = await fetch(resolveUrl(params.config, params.statusUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${params.authToken}`,
    },
    signal: params.signal,
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    const error = errorMessageFromBody(body, `Bench cloud returned HTTP ${response.status}`);
    throw new BenchCloudBridgeError(error.message, {
      status: response.status,
      code: error.code,
    });
  }
  return assertTurnStatusResponse(body);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      return err;
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollBenchCloudCliTurnStatus(params: {
  config: BenchCloudBridgeConfig;
  authToken: string;
  statusUrl: string;
  signal?: AbortSignal;
}): Promise<BenchCloudCliTurnStatusResponse> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.config.pollTimeoutMs) {
    const status = await readBenchCloudCliTurnStatus(params);
    if (
      status.status === "completed" ||
      status.status === "failed" ||
      status.status === "rejected" ||
      status.status === "expired" ||
      status.status === "revoked"
    ) {
      return status;
    }
    await delay(params.config.pollIntervalMs, params.signal);
  }
  throw new BenchCloudBridgeError(
    `cloud-brain turn did not complete within ${params.config.pollTimeoutMs}ms`,
    { code: "poll_timeout" },
  );
}
