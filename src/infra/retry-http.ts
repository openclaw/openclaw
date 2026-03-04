import type { RetryInfo, RetryOptions, RetryPredicate } from "./retry.js";
import { retryAsync } from "./retry.js";

class HTTPError extends Error {
  readonly status: number;

  private constructor(message: string, status: number) {
    super(message);
    this.name = "HTTPError";
    this.status = status;
  }

  private static async createMessage(res: Response, label?: string): Promise<string> {
    const labelPart = label ? `[${label}]: ` : "";
    const text = await res
      .text()
      .then((v) => `: ${v}`)
      .catch(() => "");
    return `${labelPart}HTTP ${res.status} ${res.statusText}${text}`;
  }

  static async fromResponse(res: Response, label?: string): Promise<HTTPError> {
    const message = await HTTPError.createMessage(res, label);
    return new HTTPError(message, res.status);
  }
}

export type RetryLogger = (msg: string) => void;

export type ResponseValidator = (res: Response) => Promise<Response>;

export type ErrorFactory = (res: Response) => Promise<Error>;

export type ResponseTransformer<T> = (res: Response) => Promise<T>;

export type RetryHttpOptions<T = Response> = RetryOptions & {
  logger?: RetryLogger;
  onResponse?: ResponseValidator;
  createError?: ErrorFactory;
  transformResponse?: ResponseTransformer<T>;
};

// HTTP status codes that are safe to retry
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  425, // Too Early (TLS renegotiation)
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
  522, // Connection timed out (Cloudflare)
  524, // A timeout occurred (Cloudflare)
]);

// Network error codes that indicate transient failures
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNABORTED", // connection aborted (common with timeouts)
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "ENETUNREACH",
  "ENOTCONN",
  "EAI_AGAIN", // DNS temporary failure (try again)
]);

export function isHttpRetryable(err: unknown): boolean {
  if (err instanceof TypeError && err.message.toLowerCase() === "fetch failed") {
    return true;
  }
  if (hasRetryableNetworkErrorInChain(err)) {
    return true;
  }
  if (isRetryableHttpStatusError(err)) {
    return true;
  }
  return false;
}

// Traverse error chain (cause, errors) to find retryable network error codes
function hasRetryableNetworkErrorInChain(err: unknown): boolean {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      errors?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    const code =
      typeof candidate.code === "string"
        ? candidate.code
        : typeof candidate.errno === "string"
          ? candidate.errno
          : undefined;
    if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
    if (candidate.cause) {
      queue.push(candidate.cause);
    }
    if (Array.isArray(candidate.errors)) {
      queue.push(...candidate.errors);
    }
  }
  return false;
}

export async function retryHttpAsync<T>(
  fn: () => Promise<Response>,
  options: RetryHttpOptions<T>,
): Promise<T> {
  const {
    logger = console.warn,
    createError = createErrorFactory(options.label),
    onResponse: validate = onResponse(createError),
    transformResponse: transform = async (res: Response) => res as unknown as T,
    ...retryOptions
  } = options;
  const res = await retryAsync(() => fn().then(validate), {
    ...retryOptions,
    shouldRetry: options.shouldRetry ?? shouldRetry(options.attempts),
    onRetry: options.onRetry ?? ((info) => onRetry(logger, info)),
  });
  return transform(res);
}

export function onRetry(logger: RetryLogger, info: RetryInfo) {
  const errMsg = info.err instanceof Error ? info.err.message : String(info.err);
  const labelPart = info.label ? `[${info.label}] ` : "";
  logger(`${labelPart}Retry ${info.attempt}/${info.maxAttempts} failed: ${errMsg}`);
}

function hasRetryableErrorCode(err: unknown, codeProp: string, codes: Set<unknown>): boolean {
  if (typeof err === "object" && err !== null && codeProp in err) {
    const code = (err as Record<string, unknown>)[codeProp];
    return codes.has(code);
  }
  return false;
}

function isRetryableHttpStatusError(err: unknown): boolean {
  return hasRetryableErrorCode(err, "status", RETRYABLE_STATUS_CODES);
}

function shouldRetry(attempts?: number): RetryPredicate {
  const maxAttempts = attemptsOrElse(attempts);
  return (err, attempt) => attempt <= maxAttempts && isHttpRetryable(err);
}

function attemptsOrElse(attempts?: number, defaultAttempts: number = 3) {
  return typeof attempts === "number" && attempts > 0 ? attempts : defaultAttempts;
}

function createErrorFactory(label?: string): ErrorFactory {
  return async (res: Response) => await HTTPError.fromResponse(res, label);
}

function onResponse(createError: ErrorFactory): ResponseValidator {
  return async (res: Response) => {
    if (!res.ok) {
      throw await createError(res);
    }
    return res;
  };
}
