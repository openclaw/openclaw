import { describe, expect, it } from "vitest";
import { generateEd25519Signer } from "../../../packages/openclaw-id-protocol/src/index.js";
import { createDiscoveryClient } from "./discovery-client.js";

describe("Discovery client cancellation", () => {
  it("cancels a request in flight when its lifecycle stops", async () => {
    const lifecycle = new AbortController();
    const requestStarted = Promise.withResolvers<AbortSignal | null | undefined>();
    let finishRequest: (() => void) | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
      await new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const cancel = () => reject(new Error("aborted", { cause: signal?.reason }));
        finishRequest = () => {
          signal?.removeEventListener("abort", cancel);
          resolve(Response.json({}));
        };
        if (signal?.aborted) {
          cancel();
        }
        signal?.addEventListener("abort", cancel);
        requestStarted.resolve(signal);
      })) as typeof fetch;
    const client = createDiscoveryClient({
      baseUrl: "https://discovery.example.test",
      signer: await generateEd25519Signer(),
      fetchImpl,
      signal: lifecycle.signal,
    });
    const pending = client.getRegistration("claw");
    try {
      const signal = await requestStarted.promise;
      lifecycle.abort(new Error("stopped"));
      expect(signal?.aborted).toBe(true);
      await expect(pending).rejects.toThrow("aborted");
    } finally {
      finishRequest?.();
      await pending.catch(() => {});
    }
  });
});

describe("Discovery client errors", () => {
  it("carries the published binding a descriptor refusal names", async () => {
    const binding = { body: { binding_seq: 3 }, sig: "x" };
    const client = createDiscoveryClient({
      baseUrl: "https://discovery.example.test",
      signer: await generateEd25519Signer(),
      fetchImpl: (async () =>
        Response.json(
          { error: { code: "stale_binding", message: "older", binding } },
          { status: 409 },
        )) as typeof fetch,
    });
    await expect(client.getRegistration("claw")).rejects.toMatchObject({
      status: 409,
      code: "stale_binding",
      binding,
    });
  });
});
