import { describe, expect, it } from "vitest";
import { generateEd25519Signer } from "../../../packages/openclaw-id-protocol/src/index.js";
import { createDiscoveryClient } from "./discovery-client.js";

describe("Discovery client cancellation", () => {
  it("cancels a request in flight when its lifecycle stops", async () => {
    const lifecycle = new AbortController();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const cancel = () => reject(new Error("aborted", { cause: signal?.reason }));
        if (signal?.aborted) {
          cancel();
        }
        signal?.addEventListener("abort", cancel);
      })) as typeof fetch;
    const client = createDiscoveryClient({
      baseUrl: "https://discovery.example.test",
      signer: await generateEd25519Signer(),
      fetchImpl,
      signal: lifecycle.signal,
    });
    const pending = client.getRegistration("claw");
    lifecycle.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("aborted");
  });
});
