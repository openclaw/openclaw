import type { Dispatcher } from "undici";
import { normalizeHeadersInitForFetch } from "../fetch-headers.js";
import { loadUndiciRuntimeDeps, type UndiciRuntimeDeps } from "./undici-runtime.js";

export type DispatcherAwareRequestInit = RequestInit & { dispatcher?: Dispatcher };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type RuntimeFormDataCtor = NonNullable<UndiciRuntimeDeps["FormData"]>;

type FormDataEntryValueWithOptionalName = FormDataEntryValue & { name?: string };

function isFormDataLike(value: unknown): value is FormData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FormData).entries === "function" &&
    (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === "FormData"
  );
}

function normalizeRuntimeFormData(
  body: unknown,
  RuntimeFormData: RuntimeFormDataCtor | undefined,
): BodyInit | null | undefined {
  if (!isFormDataLike(body) || typeof RuntimeFormData !== "function") {
    return body as BodyInit | null | undefined;
  }
  if (body instanceof RuntimeFormData) {
    return body;
  }

  const next = new RuntimeFormData();
  for (const [key, value] of body.entries()) {
    const namedValue = value as FormDataEntryValueWithOptionalName;
    // File.name is the standard filename property; skip empty/whitespace-only values
    const fileName =
      typeof namedValue.name === "string" && namedValue.name.trim() ? namedValue.name : undefined;
    if (fileName) {
      next.append(key, value, fileName);
    } else {
      next.append(key, value);
    }
  }
  // undici.FormData is structurally compatible with BodyInit but lives in a separate
  // type namespace; the cast avoids a cross-implementation assignability error.
  return next as unknown as BodyInit;
}

let contentLengthWarningEmitted = false;
function warnContentLengthStripped(): void {
  if (contentLengthWarningEmitted) return;
  contentLengthWarningEmitted = true;
  console.warn(
    "[plugins] dropping plugin-supplied Content-Length header — " +
      "undici computes this from the request body. " +
      "Manual Content-Length values risk request-smuggling (UND_ERR_INVALID_ARG).",
  );
}

function headerHasKey(
  headers: HeadersInit | undefined,
  key: string,
): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has(key);
  if (Array.isArray(headers)) return headers.some(([k]) => k.toLowerCase() === key);
  return Object.keys(headers).some((k) => k.toLowerCase() === key);
}

function normalizeRuntimeRequestInit(
  init: DispatcherAwareRequestInit | undefined,
  RuntimeFormData: RuntimeFormDataCtor | undefined,
): DispatcherAwareRequestInit | undefined {
  if (!init) {
    return init;
  }
  const normalizedHeaders = normalizeHeadersInitForFetch(init.headers);
  const initWithNormalizedHeaders =
    normalizedHeaders === init.headers ? init : { ...init, headers: normalizedHeaders };
  if (!init.body) {
    return initWithNormalizedHeaders;
  }

  const body = normalizeRuntimeFormData(init.body, RuntimeFormData);
  const bodyChanged = body !== init.body;

  // Always strip plugin-supplied Content-Length when a body is present.
  // Node/undici computes Content-Length from the actual transmitted bytes;
  // manual values risk request-smuggling and cause UND_ERR_INVALID_ARG.
  const hasManualContentLength = headerHasKey(normalizedHeaders, "content-length");

  if (!bodyChanged && !hasManualContentLength) {
    return initWithNormalizedHeaders;
  }

  if (hasManualContentLength) {
    warnContentLengthStripped();
  }

  const headers = new Headers(normalizedHeaders);
  headers.delete("content-length");
  if (bodyChanged) {
    headers.delete("content-type");
  }
  return {
    ...initWithNormalizedHeaders,
    headers,
    body: bodyChanged ? body : init.body,
  };
}

export function isMockedFetch(fetchImpl: FetchLike | undefined): boolean {
  if (typeof fetchImpl !== "function") {
    return false;
  }
  return typeof (fetchImpl as FetchLike & { mock?: unknown }).mock === "object";
}

export async function fetchWithRuntimeDispatcher(
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  const runtimeDeps = loadUndiciRuntimeDeps();
  const runtimeFetch = runtimeDeps.fetch as unknown as (
    input: RequestInfo | URL,
    init?: DispatcherAwareRequestInit,
  ) => Promise<unknown>;
  return (await runtimeFetch(
    input,
    normalizeRuntimeRequestInit(init, runtimeDeps.FormData),
  )) as Response;
}

export async function fetchWithRuntimeDispatcherOrMockedGlobal(
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  if (isMockedFetch(globalThis.fetch)) {
    return await globalThis.fetch(input, init);
  }
  return await fetchWithRuntimeDispatcher(input, init);
}
