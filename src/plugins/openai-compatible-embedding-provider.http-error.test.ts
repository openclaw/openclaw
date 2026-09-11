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
  it.each([
    {
      label: "short rate-limit",
      padding: 0,
      credentialPadding: 0,
      code: "rate_limit_exceeded",
      errorType: "rate_limit_error",
      retryAfter: "4",
      retryAfterMs: 4_000,
    },
    {
      label: "complete long quota",
      padding: 1_200,
      credentialPadding: 0,
      code: "insufficient_quota",
      errorType: "insufficient_quota",
      retryAfter: undefined,
      retryAfterMs: undefined,
    },
    {
      label: "byte-limited error",
      padding: 0,
      credentialPadding: 9 * 1024,
      code: undefined,
      errorType: undefined,
      retryAfter: undefined,
      retryAfterMs: undefined,
    },
  ])(
    "preserves $label metadata while redacting reflected request credentials",
    async ({ padding, credentialPadding, code, errorType, retryAfter, retryAfterMs }) => {
      const tokenPrefix = "secret-reflected-token";
      const token = `${tokenPrefix}${"q".repeat(credentialPadding)}`;
      const body = JSON.stringify({
        error: {
          message: `${padding || credentialPadding ? "Request rejected" : "Quota exhausted"} for ${token}${"x".repeat(padding)}`,
          type: errorType,
          code,
        },
      });
      if (credentialPadding) {
        expect(Buffer.byteLength(body)).toBeGreaterThan(8 * 1024);
      } else if (padding) {
        expect(body.length).toBeGreaterThan(1_000);
        expect(Buffer.byteLength(body)).toBeLessThan(8 * 1024);
      }
      const server = createServer((request, response) => {
        request.resume();
        request.once("end", () => {
          expect(request.headers.authorization).toBe(`Bearer ${token}`);
          response.writeHead(429, {
            "content-type": "application/json",
            ...(retryAfter ? { "retry-after": retryAfter } : {}),
          });
          response.end(body);
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
        code,
        errorType,
        retryAfterMs,
      });
      expect((error as Error).message).toContain("openai-compatible embeddings failed: HTTP 429");
      expect((error as Error).message).not.toContain(tokenPrefix);
      expect((error as ProviderHttpError).errorBody).not.toContain(tokenPrefix);
      if (credentialPadding) {
        expect((error as Error).message).toContain("Request rejected for ***... [truncated]");
        expect((error as ProviderHttpError).errorBody).toContain("Request rejected for ***");
      }
    },
  );
});
