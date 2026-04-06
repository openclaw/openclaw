import type { Dispatcher } from "undici";
import { loadUndiciRuntimeDeps } from "./undici-runtime.js";

export type DispatcherAwareRequestInit = RequestInit & { dispatcher?: Dispatcher };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  return (await runtimeFetch(input, init)) as Response;
}
