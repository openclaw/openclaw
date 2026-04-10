import type { Dispatcher } from "undici";
import { loadUndiciRuntimeDeps } from "./undici-runtime.js";

export type DispatcherAwareRequestInit = RequestInit & { dispatcher?: Dispatcher };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isFormDataBody(body: BodyInit | null | undefined): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function normalizeRuntimeMultipartInit(
  init: DispatcherAwareRequestInit | undefined,
): DispatcherAwareRequestInit | undefined {
  if (!init || !isFormDataBody(init.body)) {
    return init;
  }

  const { FormData: RuntimeFormData } = loadUndiciRuntimeDeps();
  if (typeof RuntimeFormData !== "function") {
    return init;
  }
  const runtimeForm = new RuntimeFormData();
  for (const [key, value] of init.body.entries()) {
    if (typeof value === "string") {
      runtimeForm.append(key, value);
      continue;
    }
    const filename = typeof File !== "undefined" && value instanceof File ? value.name : undefined;
    if (filename) {
      runtimeForm.append(key, value, filename);
    } else {
      runtimeForm.append(key, value);
    }
  }

  const headers = new Headers(init.headers);
  headers.delete("content-type");
  headers.delete("content-length");

  return {
    ...init,
    headers,
    body: runtimeForm,
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
  const runtimeFetch = loadUndiciRuntimeDeps().fetch as unknown as (
    input: RequestInfo | URL,
    init?: DispatcherAwareRequestInit,
  ) => Promise<unknown>;
  return (await runtimeFetch(input, normalizeRuntimeMultipartInit(init))) as Response;
}
