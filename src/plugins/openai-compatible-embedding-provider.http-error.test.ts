import "../test-utils/prepare-compiled-subprocesses.js";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import * as httpFixtures from "../../test/helpers/gateway-integration-fixtures.js";
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

it.each<[string, number, number, string?, string?, string?, number?]>([
  ["short rate-limit", 0, 0, "rate_limit_exceeded", "rate_limit_error", "4", 4_000],
  ["complete long quota", 1_200, 0, "insufficient_quota", "insufficient_quota"],
  ["byte-limited error", 0, 9 * 1024],
])(
  "OpenAI-compatible embeddings: preserves %s metadata and redacts credentials",
  async (_label, padding, credentialPadding, code, errorType, retryAfter, retryAfterMs) => {
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
    const origin = await httpFixtures.listenLoopback(server);

    const result = await openAICompatibleEmbeddingProviderAdapter.create({
      config: {},
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
      dimensions: 3,
      remote: { baseUrl: `${origin}/v1`, apiKey: token },
    });
    if (!result.provider) {
      throw new Error("expected OpenAI-compatible embedding provider");
    }

    const error = await result.provider.embed("hello").catch((cause: unknown) => cause);
    const failure = error as ProviderHttpError;
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 429, code, errorType, retryAfterMs });
    expect(failure.message).toContain(
      "openai-compatible embeddings failed (model: text-embedding-bge-m3, batch size: 1): HTTP 429",
    );
    expect(failure.message).not.toContain(tokenPrefix);
    expect(failure.errorBody).not.toContain(tokenPrefix);
    if (credentialPadding) {
      expect(failure.message).toContain("Request rejected for ***... [truncated]");
      expect(failure.errorBody).toContain("Request rejected for ***");
    }
  },
);
