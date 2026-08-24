import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { loadModelAuthStatus } from "./model-auth.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("loadModelAuthStatus", () => {
  it("coalesces same-scope consumers without sharing caller cancellation", async () => {
    const response = deferred<ModelAuthStatusResult>();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(
      (
        _method: string,
        _params?: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<ModelAuthStatusResult> => {
        requestSignal = options?.signal;
        return response.promise;
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const abort = new AbortController();

    const cancelled = loadModelAuthStatus(client, { agentId: "main", signal: abort.signal });
    const surviving = loadModelAuthStatus(client, { agentId: "main" });

    expect(request).toHaveBeenCalledOnce();
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBe(false);

    const result = { ts: 1, providers: [] };
    response.resolve(result);
    await expect(surviving).resolves.toBe(result);
  });

  it("keeps forced refreshes and agent scopes in separate requests", async () => {
    const response = deferred<ModelAuthStatusResult>();
    const request = vi.fn(
      (_method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => response.promise,
    );
    const client = { request } as unknown as GatewayBrowserClient;

    const loads = [
      loadModelAuthStatus(client, { agentId: "main" }),
      loadModelAuthStatus(client, { agentId: "main" }),
      loadModelAuthStatus(client, { agentId: "main", refresh: true }),
      loadModelAuthStatus(client, { agentId: "writer" }),
    ];

    expect(request.mock.calls.map(([, params]) => params)).toEqual([
      { agentId: "main" },
      { refresh: true, agentId: "main" },
      { agentId: "writer" },
    ]);
    response.resolve({ ts: 1, providers: [] });
    await Promise.all(loads);
  });
});
