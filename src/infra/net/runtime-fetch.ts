// Runtime fetch adapter preserves undici dispatcher support and normalizes
// headers/FormData before calling the runtime fetch implementation.
import type { Dispatcher } from "undici";
import { normalizeRequestInitHeadersForFetch } from "../fetch-headers.js";
import { isFormDataLike } from "./form-data.js";
import { loadUndiciRuntimeDeps, type UndiciRuntimeDeps } from "./undici-runtime.js";

export type DispatcherAwareRequestInit = RequestInit & { dispatcher?: Dispatcher };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FormDataEntryValueWithOptionalName = FormDataEntryValue & { name?: string };

/** Returns true for Vitest-style mocked fetch functions that should stay injectable. */
export function isMockedFetch(fetchImpl: FetchLike | undefined): boolean {
  if (typeof fetchImpl !== "function") {
    return false;
  }
  return typeof (fetchImpl as FetchLike & { mock?: unknown }).mock === "object";
}

/** Uses the undici runtime fetch so callers can pass dispatcher-aware options. */
export async function fetchWithRuntimeDispatcher(
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  return await fetchWithPreparedRuntimeDispatcher(loadUndiciRuntimeDeps(), input, init);
}

/** Uses one prepared Undici snapshot so reusable fetch wrappers stay stable. */
export function fetchWithPreparedRuntimeDispatcher(
  runtimeDeps: UndiciRuntimeDeps,
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  const runtimeFetch = runtimeDeps.fetch as unknown as (
    input: RequestInfo | URL,
    init?: DispatcherAwareRequestInit,
  ) => Promise<Response>;
  const normalizedInit = normalizeRequestInitHeadersForFetch(init);
  const RuntimeFormData = runtimeDeps.FormData;
  if (
    !init ||
    !isFormDataLike(init.body) ||
    typeof RuntimeFormData !== "function" ||
    init.body instanceof RuntimeFormData
  ) {
    return runtimeFetch(input, normalizedInit);
  }
  // Node global FormData and undici runtime FormData can differ; rebuild into
  // the runtime constructor so multipart uploads stream correctly.
  const body = new RuntimeFormData();
  for (const [key, value] of init.body.entries()) {
    const namedValue = value as FormDataEntryValueWithOptionalName;
    const fileName =
      typeof namedValue.name === "string" && namedValue.name.trim() ? namedValue.name : undefined;
    if (fileName) {
      body.append(key, value, fileName);
    } else {
      body.append(key, value);
    }
  }
  // The rebuilt FormData will choose its own boundary and length; stale caller
  // values make undici send an invalid multipart request.
  const headers = new Headers(normalizedInit?.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return runtimeFetch(input, {
    ...normalizedInit,
    headers,
    // undici.FormData is structurally compatible but uses a separate type namespace.
    body: body as unknown as BodyInit,
  });
}

/**
 * Uses test-injected global fetch when present, otherwise preserves dispatcher
 * support by routing through the undici runtime fetch.
 */
export async function fetchWithRuntimeDispatcherOrMockedGlobal(
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  if (isMockedFetch(globalThis.fetch)) {
    return await globalThis.fetch(input, init);
  }
  return await fetchWithRuntimeDispatcher(input, init);
}
