// Child of the provider attempt test. The parent loads a connect interposer that
// drops the IPv4 handshake for OPENCLAW_DROP_PORT; this process makes the request.
import http from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { Model } from "../../llm/types.js";

const DNS_FIXTURE_URL = "openclaw-drop-dns:promises";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:dns/promises" && context.parentURL !== DNS_FIXTURE_URL) {
      return { url: DNS_FIXTURE_URL, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== DNS_FIXTURE_URL) {
      return next(url, context);
    }
    return {
      format: "module",
      shortCircuit: true,
      source: `
        import * as actual from "node:dns/promises";
        export * from "node:dns/promises";
        export function lookup(hostname, options) {
          if (hostname === "fixture.test") {
            return Promise.resolve([
              { address: "127.0.0.1", family: 4 },
              { address: "::1", family: 6 },
            ]);
          }
          return actual.lookup(hostname, options);
        }
      `,
    };
  },
});

const { attachModelProviderRequestTransport } =
  await import("../../agents/provider-request-config.js");
const { closeProviderTransportDispatcherPool } =
  await import("../../agents/provider-transport-dispatcher-pool.js");
const { buildGuardedModelFetch } = await import("../../agents/provider-transport-fetch.js");
const { attachProviderAuthAuthority } = await import("../../plugins/provider-auth-authority.js");
const { resolveUndiciAutoSelectFamilyConnectOptions } = await import("./undici-family-policy.js");

const server = http.createServer((_request, response) => {
  response.end("ok");
});
const sockets = new Set<Socket>();
server.on("connection", (socket) => {
  sockets.add(socket);
});
await new Promise<void>((resolve) => {
  server.listen(0, "::1", () => resolve());
});
const port = (server.address() as AddressInfo).port;
process.env.OPENCLAW_DROP_PORT = String(port);

const baseUrl = `http://fixture.test:${port}/v1`;
const model = attachProviderAuthAuthority(
  attachModelProviderRequestTransport(
    {
      id: "family-attempt",
      name: "family-attempt",
      provider: "family-attempt-fixture",
      api: "openai-responses",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 16,
    } as Model<"openai-responses">,
    { allowPrivateNetwork: true },
  ),
  () => undefined,
);

const started = performance.now();
try {
  const response = await buildGuardedModelFetch(model)(`${baseUrl}/models`);
  const body = await response.text();
  if (body !== "ok") {
    throw new Error(`unexpected provider body: ${body}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
      attemptTimeoutMs:
        resolveUndiciAutoSelectFamilyConnectOptions()?.autoSelectFamilyAttemptTimeout ?? null,
    })}\n`,
  );
} catch (error) {
  const cause = error as { code?: string; cause?: { code?: string }; message?: string };
  process.stdout.write(
    `${JSON.stringify({
      failed: true,
      code: cause.code ?? cause.cause?.code ?? null,
      message: cause.message ?? "provider request failed",
      elapsedMs: Math.round(performance.now() - started),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closeProviderTransportDispatcherPool();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}
