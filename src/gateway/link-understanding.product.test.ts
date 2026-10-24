import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createChatFixture, sendChatAndWait } from "./gateway-chat-fixture.test-support.js";

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
        policy: { ...params.policy, allowPrivateNetwork: true },
      }),
  };
});

it(
  "Gateway link understanding fetches bare URLs but not titled markdown links through chat.send",
  { timeout: 90_000 },
  async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const linkRequests: string[] = [];
    const linkServer = createServer((request, response) => {
      const requestPath = request.url ?? "";
      linkRequests.push(requestPath);
      response.end(requestPath === "/citation" ? "CITATION_PAGE" : "BARE_PAGE");
    });
    const fixture = createChatFixture("link-understanding", {
      configure: (config) => ({
        ...config,
        agents: { ...config.agents, entries: { main: {} } },
        tools: {
          links: {
            enabled: true,
            models: [{ type: "cli", command: "curl", args: ["{{LinkUrl}}"] }],
          },
        },
      }),
      respond: async () => "OK",
    });
    await runQaGatewayFixture(
      async () => {
        const linkUrl = new URL(await listenLoopback(linkServer));
        await fixture.start();
        const linkBase = `http://loopback.test:${linkUrl.port}`;
        const runId = await sendChatAndWait(
          fixture.client,
          "agent:main:link-understanding-gateway",
          `[citation](${linkBase}/citation "Citation") ${linkBase}/bare`,
        );
        expect(runId).toBeTypeOf("string");
        expect(linkRequests).toEqual(["/bare"]);
        expect(fixture.requests.join("\n")).toContain("BARE_PAGE");
        expect(fixture.requests.join("\n")).not.toContain("CITATION_PAGE");
      },
      () => fixture.close(),
      async () => {
        if (linkServer.listening) {
          await closeHttpServer(linkServer);
        }
      },
      () => vi.unstubAllEnvs(),
    );
  },
);
