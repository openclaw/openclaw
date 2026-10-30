import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { exactButton } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const sessionKey = "agent:main:private-side-chat";
const people = [
  { name: "Alice Example", email: "alice@example.test" },
  { name: "Bob Example", email: "bob@example.test" },
];
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startEchoInference>>;
const proxies: ViteDevServer[] = [];
const urls: string[] = [];

// Only inference is synthetic: it answers the latest question it received.
async function startEchoInference() {
  const responses = new Set<ServerResponse>();
  const questions: string[] = [];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    responses.add(response);
    response.once("close", () => responses.delete(response));
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      // The question is the newest one in the request; earlier context may precede it.
      const question = Buffer.concat(chunks)
        .toString("utf8")
        .match(/Question [AB]\d/g)
        ?.at(-1);
      questions.push(question ?? "unknown");
      const text = "Answer to " + (question ?? "unknown");
      const id = "echo-" + questions.length;
      const message = {
        type: "message",
        id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const emit = (event: Record<string, unknown>) =>
        response.write("data: " + JSON.stringify(event) + "\n\n");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      emit({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, content: [] },
      });
      const part = { item_id: id, output_index: 0, content_index: 0 };
      emit({ type: "response.output_text.delta", ...part, delta: text });
      emit({ type: "response.output_text.done", ...part, text });
      emit({ type: "response.output_item.done", output_index: 0, item: message });
      emit({
        type: "response.completed",
        response: {
          id: "response-" + id,
          status: "completed",
          output: [message],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      });
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Inference fixture did not bind loopback");
  }
  return {
    port: address.port,
    questions,
    requests,
    async close() {
      for (const response of responses) {
        response.destroy();
      }
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

const suite = createControlUiE2eSuite({
  name: "Real Gateway private Side chat",
  startServerBeforeBrowser: true,
  async startServer() {
    provider = await startEchoInference();
    const close = async () => {
      await runQaGatewayFixture(
        async () => {},
        ...proxies.map((proxy) => () => proxy.close()),
        () => instance?.cleanup(),
        () => provider.close(),
      );
    };
    try {
      instance = await createOpenClawTestInstance({
        name: "private-side-chat-real-gateway",
        env: { VITEST: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
        config: {
          gateway: {
            controlUi: { enabled: true },
            trustedProxies: ["127.0.0.1", "::1"],
            auth: {
              mode: "trusted-proxy",
              trustedProxy: {
                allowLoopback: true,
                allowUsers: people.map((person) => person.email),
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                deviceAutoApprove: {
                  enabled: true,
                  scopes: ["operator.admin", "operator.read", "operator.write"],
                },
              },
            },
          },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "echo-fixture/echo",
              utilityModel: "echo-fixture/echo",
              modelPolicy: { allow: ["echo-fixture/*"] },
            },
            entries: { main: { identity: { name: "Echo Fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "echo-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-fixture-key",
                baseUrl: "http://127.0.0.1:" + provider.port + "/v1",
                models: [{ id: "echo", name: "Echo fixture" }],
              },
            },
          },
          plugins: { allow: [] },
        },
      });
      for (const [index, person] of people.entries()) {
        const profile = ensureProfileForEmail(person.email, { env: instance.env });
        setDisplayName(profile.id, person.name, { env: instance.env });
        const proxy = await createGatewayProxy(instance.state.workspaceDir, {
          "/": gatewayProxyRoute(instance.port, person.email, "192.0.2." + (10 + index)),
        });
        proxies.push(proxy);
        await proxy.listen();
        const url = proxy.resolvedUrls?.local[0];
        if (!url) {
          throw new Error("Fixed-user loopback proxy did not expose a URL");
        }
        urls.push(url);
      }
      const config = JSON.parse(await readFile(instance.configPath, "utf8"));
      // The instance helper defaults to token auth; this fixture uses real proxy identities.
      delete config.gateway.auth.token;
      config.gateway.controlUi.allowedOrigins = urls.map((url) => new URL(url).origin);
      await instance.state.writeConfig(config);
      await instance.startGateway();
      return { baseUrl: urls[0]!, close };
    } catch (error) {
      return await runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

function sideChat(page: Page) {
  const rail = page.locator("openclaw-chat-session-rail");
  const text = (value: string) => rail.getByText(value, { exact: true });
  return {
    text,
    async ask(question: string) {
      await rail.getByRole("textbox", { name: "Ask in side chat", exact: true }).fill(question);
      await rail.getByRole("button", { name: "Ask", exact: true }).click();
      await text("Answer to " + question)
        .waitFor({ timeout: 30_000 })
        .catch((error: unknown) => {
          throw new Error(
            "No Side chat answer; inference saw " + JSON.stringify(provider.requests),
            {
              cause: error,
            },
          );
        });
    },
  };
}

async function openSession(page: Page, index: number) {
  await page.goto(controlUiSessionUrl(urls[index]!, sessionKey));
  await waitForControlUiGatewayReady(page);
  await expect
    .poll(() => page.locator("openclaw-app-sidebar").textContent())
    .toContain(people[index]!.name);
  await openChatSidePanelType(page, "Side chat");
}

suite.define(() => {
  it("keeps each person's Side chat thread private within a shared session", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const options = {
          locale: "en-US",
          serviceWorkers: "block" as const,
          viewport: { width: 1440, height: 900 },
        };
        await suite.withPage(options, async ({ page: alice }) => {
          await suite.withPage(options, async ({ page: bob }) => {
            const pages = [alice, bob];
            const a = sideChat(alice);
            const b = sideChat(bob);
            for (const [index, page] of pages.entries()) {
              await page.addInitScript(() =>
                localStorage.setItem(
                  "openclaw:control-ui:community-invite:v2",
                  JSON.stringify({ dismissedAtMs: 1770000000000 }),
                ),
              );
              await page.goto(new URL("settings/profile", urls[index]!).href);
              await waitForControlUiGatewayReady(page);
            }
            await evaluateControlUiContext(
              alice,
              async (application, key) => {
                const client = application.gateway.snapshot.client;
                if (!client) {
                  throw new Error("Authenticated client missing");
                }
                return await client.request("sessions.create", {
                  key,
                  agentId: "main",
                  label: "Shared session",
                  visibility: "shared",
                });
              },
              sessionKey,
            );
            for (const [index, page] of pages.entries()) {
              await openSession(page, index);
            }

            await a.ask("Question A1");
            await b.ask("Question B1");
            expect(provider.questions).toEqual(["Question A1", "Question B1"]);

            // Each person sees only their own exchange, including after reloading.
            for (const [index, page] of pages.entries()) {
              await openSession(page, index);
            }
            await a.text("Answer to Question A1").waitFor();
            await b.text("Answer to Question B1").waitFor();
            for (const [own, other] of [
              [a, "B1"],
              [b, "A1"],
            ] as const) {
              expect(await own.text("Question " + other).count()).toBe(0);
              expect(await own.text("Answer to Question " + other).count()).toBe(0);
            }

            // Clearing one person's thread leaves the other person's thread intact.
            await exactButton(bob, "Close Side chat").click();
            await b.text("Answer to Question B1").waitFor({ state: "detached" });
            await openSession(alice, 0);
            await a.text("Answer to Question A1").waitFor();
            await openSession(bob, 1);
            expect(await b.text("Answer to Question B1").count()).toBe(0);
          });
        });
      },
    });
  });
});
