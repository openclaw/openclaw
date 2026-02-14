import type { IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

export type RequestBodyLimitErrorCode =
  | "PAYLOAD_TOO_LARGE"
  | "REQUEST_BODY_TIMEOUT"
  | "CONNECTION_CLOSED";

type RequestBodyLimitErrorInit = {
  code: RequestBodyLimitErrorCode;
  message?: string;
};

const DEFAULT_ERROR_MESSAGE: Record<RequestBodyLimitErrorCode, string> = {
  PAYLOAD_TOO_LARGE: "PayloadTooLarge",
  REQUEST_BODY_TIMEOUT: "RequestBodyTimeout",
  CONNECTION_CLOSED: "RequestBodyConnectionClosed",
};

const DEFAULT_ERROR_STATUS_CODE: Record<RequestBodyLimitErrorCode, number> = {
  PAYLOAD_TOO_LARGE: 413,
  REQUEST_BODY_TIMEOUT: 408,
  CONNECTION_CLOSED: 400,
};

const DEFAULT_RESPONSE_MESSAGE: Record<RequestBodyLimitErrorCode, string> = {
  PAYLOAD_TOO_LARGE: "Payload too large",
  REQUEST_BODY_TIMEOUT: "Request body timeout",
  CONNECTION_CLOSED: "Connection closed",
};

export class RequestBodyLimitError extends Error {
  readonly code: RequestBodyLimitErrorCode;
  readonly statusCode: number;

  constructor(init: RequestBodyLimitErrorInit) {
    super(init.message ?? DEFAULT_ERROR_MESSAGE[init.code]);
    this.name = "RequestBodyLimitError";
    this.code = init.code;
    this.statusCode = DEFAULT_ERROR_STATUS_CODE[init.code];
  }
}

export function isRequestBodyLimitError(
  error: unknown,
  code?: RequestBodyLimitErrorCode,
): error is RequestBodyLimitError {
  if (!(error instanceof RequestBodyLimitError)) {
    return false;
  }
  if (!code) {
    return true;
  }
  return error.code === code;
}

export function requestBodyErrorToText(code: RequestBodyLimitErrorCode): string {
  return DEFAULT_RESPONSE_MESSAGE[code];
}

function parseContentLengthHeader(req: IncomingMessage): number | null {
  const header = req.headers["content-length"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export type ReadRequestBodyOptions = {
  maxBytes: number;
  timeoutMs?: number;
  encoding?: BufferEncoding;
};

export async function readRequestBodyWithLimit(
  req: IncomingMessage,
  options: ReadRequestBodyOptions,
): Promise<string> {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(1, Math.floor(options.maxBytes))
    : 1;
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : DEFAULT_WEBHOOK_BODY_TIMEOUT_MS;
  const encoding = options.encoding ?? "utf-8";

  const declaredLength = parseContentLengthHeader(req);
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
    if (!req.destroyed) {
      req.destroy(error);
    }
    throw error;
  }

  return await new Promise((resolve, reject) => {
    let done = false;
    let ended = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
      clearTimeout(timer);
    };

    const finish = (cb: () => void) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      cb();
    };

    const fail = (error: RequestBodyLimitError | Error) => {
      finish(() => reject(error));
    };

    const timer = setTimeout(() => {
      const error = new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" });
      if (!req.destroyed) {
        req.destroy(error);
      }
      fail(error);
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      if (done) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
        if (!req.destroyed) {
          req.destroy(error);
        }
        fail(error);
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      ended = true;
      finish(() => resolve(Buffer.concat(chunks).toString(encoding)));
    };

    const onError = (error: Error) => {
      if (done) {
        return;
      }
      fail(error);
    };

    const onClose = () => {
      if (done || ended) {
        return;
      }
      fail(new RequestBodyLimitError({ code: "CONNECTION_CLOSED" }));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code: RequestBodyLimitErrorCode | "INVALID_JSON" };

export type ReadJsonBodyOptions = ReadRequestBodyOptions & {
  emptyObjectOnEmpty?: boolean;
};

export async function readJsonBodyWithLimit(
  req: IncomingMessage,
  options: ReadJsonBodyOptions,
): Promise<ReadJsonBodyResult> {
  try {
    const raw = await readRequestBodyWithLimit(req, options);
    const trimmed = raw.trim();
    if (!trimmed) {
      if (options.emptyObjectOnEmpty === false) {
        return { ok: false, code: "INVALID_JSON", error: "empty payload" };
      }
      return { ok: true, value: {} };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_JSON",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      return { ok: false, code: error.code, error: requestBodyErrorToText(error.code) };
    }
    return {
      ok: false,
      code: "INVALID_JSON",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type RequestBodyLimitGuard = {
  dispose: () => void;
  isTripped: () => boolean;
  code: () => RequestBodyLimitErrorCode | null;
};

export type RequestBodyLimitGuardOptions = {
  maxBytes: number;
  timeoutMs?: number;
  responseFormat?: "json" | "text";
  responseText?: Partial<Record<RequestBodyLimitErrorCode, string>>;
};

export function installRequestBodyLimitGuard(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestBodyLimitGuardOptions,
): RequestBodyLimitGuard {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(1, Math.floor(options.maxBytes))
    : 1;
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : DEFAULT_WEBHOOK_BODY_TIMEOUT_MS;
  const responseFormat = options.responseFormat ?? "json";
  const customText = options.responseText ?? {};

  let tripped = false;
  let reason: RequestBodyLimitErrorCode | null = null;
  let done = false;
  let ended = false;
  let totalBytes = 0;

  const cleanup = () => {
    req.removeListener("data", onData);
    req.removeListener("end", onEnd);
    req.removeListener("close", onClose);
    req.removeListener("error", onError);
    clearTimeout(timer);
  };

  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    cleanup();
  };

  const respond = (error: RequestBodyLimitError) => {
    const text = customText[error.code] ?? requestBodyErrorToText(error.code);
    if (!res.headersSent) {
      res.statusCode = error.statusCode;
      if (responseFormat === "text") {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(text);
      } else {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: text }));
      }
    }
  };

  const trip = (error: RequestBodyLimitError) => {
    if (tripped) {
      return;
    }
    tripped = true;
    reason = error.code;
    finish();
    respond(error);
    if (!req.destroyed) {
      req.destroy(error);
    }
  };

  const onData = (chunk: Buffer | string) => {
    if (done) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      trip(new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" }));
    }
  };

  const onEnd = () => {
    ended = true;
    finish();
  };

  const onClose = () => {
    if (done || ended) {
      return;
    }
    finish();
  };

  const onError = () => {
    finish();
  };

  const timer = setTimeout(() => {
    trip(new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" }));
  }, timeoutMs);

  req.on("data", onData);
  req.on("end", onEnd);
  req.on("close", onClose);
  req.on("error", onError);

  const declaredLength = parseContentLengthHeader(req);
  if (declaredLength !== null && declaredLength > maxBytes) {
    trip(new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" }));
  }

  return {
    dispose: finish,
    isTripped: () => tripped,
    code: () => reason,
  };
}
