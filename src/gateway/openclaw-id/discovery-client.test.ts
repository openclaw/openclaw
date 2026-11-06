import { describe, expect, it } from "vitest";
import { generateEd25519Signer } from "../../../packages/openclaw-id-protocol/src/index.js";
import { createDiscoveryClient } from "./discovery-client.js";

describe("Discovery client cancellation", () => {
  it("preserves extension refusals from signed claw-name requests", async () => {
    const client = createDiscoveryClient({
      baseUrl: "https://discovery.example.test",
      signer: await generateEd25519Signer(),
      fetchImpl: async () =>
        Response.json(
          {
            error: {
              code: "preview_access_required",
              message: "Private preview",
            },
          },
          { status: 403 },
        ),
    });
    await expect(client.checkClawName("code", "studio")).rejects.toMatchObject({
      status: 403,
      code: "preview_access_required",
    });
  });

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
