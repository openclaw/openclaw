import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderHttpError } from "../agents/provider-http-errors.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    Array.from(servers, async (server) => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      servers.delete(server);
    }),
  );
});

describe("OpenAI-compatible embedding HTTP errors", () => {
  it("preserves retry metadata while redacting reflected request credentials", async () => {
    const token = "secret-reflected-token";
    const server = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        expect(request.headers.authorization).toBe(`Bearer ${token}`);
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "4",
        });
        response.end(
          JSON.stringify({
            error: {
              message: `Quota exhausted for ${token}`,
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          }),
        );
      });
    });
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    const result = await openAICompatibleEmbeddingProviderAdapter.create({
      config: {},
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
      remote: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: token },
    });
    if (!result.provider) {
      throw new Error("expected OpenAI-compatible embedding provider");
    }

    const error = await result.provider.embed("hello").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      errorType: "rate_limit_error",
      retryAfterMs: 4_000,
    });
    expect((error as Error).message).toContain("openai-compatible embeddings failed: HTTP 429");
    expect((error as Error).message).not.toContain(token);
    expect((error as ProviderHttpError).errorBody).not.toContain(token);
  });
});
