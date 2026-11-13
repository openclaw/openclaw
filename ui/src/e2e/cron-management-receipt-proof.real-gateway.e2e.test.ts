import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import { writeToolCall } from "../../../src/gateway/gateway-provider-fixture.test-support.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { CronJob } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const people = [
  { name: "Administrator", email: "admin@example.test", role: "administrator" },
  { name: "Alice Owner", email: "alice@example.test", role: "member" },
  { name: "Bob Recipient", email: "bob@example.test", role: "member" },
];
let instance: OpenClawTestInstance;
const proxies: ViteDevServer[] = [];
const urls: string[] = [];
const profiles: string[] = [];
let selectedJobId: string;
let phase: "receipt" | "admin" | "nonowner" = "receipt";
let phaseCalls = 0;
const providerInputs: unknown[] = [];
const suite = createControlUiE2eSuite({
  name: "Authenticated automation receipt tool proof",
  startServerBeforeBrowser: true,
  async startServer() {
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          void (async () => {
            const body = JSON.parse((await buffer(request)).toString());
            providerInputs.push({ phase, input: body.input });
            phaseCalls += 1;
            if (phase !== "receipt" && phaseCalls <= 2) {
              writeToolCall(response, "automations", {
                action: phaseCalls === 1 ? "get" : "runs",
                jobId: selectedJobId,
                ...(phaseCalls === 2 ? { limit: 1 } : {}),
              });
              return;
            }
            writeOpenAiResponsesText(response, {
              text: "Receipt proof " + phase + " complete.",
              messageId: "receipt-message-" + phase,
              responseId: "receipt-response-" + phase,
            });
          })().catch(() => response.writeHead(500).end());
        }),
    });
    const close = () =>
      runQaGatewayFixture(
        async () => {},
        ...proxies.map((proxy) => () => proxy.close()),
        () => instance?.cleanup(),
        async () => {
          provider.listener.closeAllConnections();
          await provider.releaseListener();
        },
        () => provider.claim.release(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "cron-management-receipt-proof",
        env: {
          VITEST: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          // Keep the disposable loopback provider local, as in the quiet-automation fixture.
          NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
            .filter(Boolean)
            .join(","),
          no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
            .filter(Boolean)
            .join(","),
        },
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
            roles: {
              default: "member",
              definitions: {
                member: {
                  scopes: ["operator.read", "operator.write"],
                  agents: "*",
                  sessions: { others: "view" },
                },
                administrator: {
                  scopes: ["operator.admin"],
                  agents: "*",
                  sessions: { others: "write" },
                },
              },
            },
          },
          cron: { enabled: false },
          tools: { profile: "full", codeMode: false, toolSearch: false },
          plugins: { allow: [] },
          agents: {
            defaults: {
              model: "fixture/echo",
              models: { "fixture/echo": { agentRuntime: { id: "openclaw" } } },
              skipBootstrap: true,
              skills: [],
            },
            entries: { main: { identity: { name: "Automation Test" } } },
          },
          models: {
            providers: {
              fixture: {
                api: "openai-responses",
                apiKey: "synthetic-owner-test",
                baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
                request: { allowPrivateNetwork: true },
                models: [{ id: "echo", name: "Fixture" }],
              },
            },
          },
        },
      });
      for (const [index, person] of people.entries()) {
        const profile = ensureProfileForEmail(person.email, { env: instance.env });
        setDisplayName(profile.id, person.name, { env: instance.env });
        setUserProfileRole(profile.id, person.role, { env: instance.env });
        profiles.push(profile.id);
        const proxy = await createGatewayProxy(instance.state.workspaceDir, {
          "/": gatewayProxyRoute(instance.port, person.email, "192.0.2." + (10 + index)),
        });
        proxies.push(proxy);
        await proxy.listen();
        const url = proxy.resolvedUrls?.local[0];
        if (!url) {
          throw new Error("Identity proxy did not expose a URL");
        }
        urls.push(url);
      }
      const config = JSON.parse(await readFile(instance.configPath, "utf8"));
      delete config.gateway.auth.token;
      config.gateway.controlUi.allowedOrigins = urls.map((url) => new URL(url).origin);
      await instance.state.writeConfig(config);
      await instance.startGateway();
      return { baseUrl: urls[0]!, close };
    } catch (error) {
      return runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

async function rpc<T>(page: Page, method: string, params: unknown): Promise<T> {
  return evaluateControlUiContext(
    page,
    (app, request) => {
      const client = app.gateway.snapshot.client;
      if (!client) {
        throw new Error("Gateway is disconnected");
      }
      return client.request<T>(request.method, request.params);
    },
    { method, params },
  );
}

suite.define(() => {
  it("reads foreign receipts as admin and denies an ordinary non-owner through authenticated chat tools", async () => {
    const artifacts = createControlUiE2eArtifactDir("management-receipt-proof");
    const pages: Page[] = [];
    try {
      for (let index = 0; index < people.length; index++) {
        const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
        const page = await context.newPage();
        await page.goto(new URL("automations", urls[index]).toString());
        await waitForControlUiGatewayReady(page);
        expect(
          await evaluateControlUiContext(page, (app) => app.gateway.snapshot.selfUser?.id),
        ).toBe(profiles[index]);
        pages.push(page);
      }
      const admin = pages[0]!;
      const job = await rpc<CronJob>(admin, "cron.add", {
        name: "Foreign receipt proof job",
        agentId: "main",
        enabled: false,
        schedule: { kind: "every", everyMs: 3600000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Return a synthetic receipt." },
        delivery: { mode: "none" },
      });
      selectedJobId = job.id;
      expect(
        await rpc(admin, "cron.run", { id: job.id, mode: "force", waitTimeoutMs: 30000 }),
      ).toMatchObject({ run: { status: "ok" } });
      for (const [name, index] of [
        ["admin", 0],
        ["nonowner", 2],
      ] as const) {
        phase = name;
        phaseCalls = 0;
        const page = pages[index]!;
        const key = "agent:main:receipt-proof-" + name;
        await rpc(page, "sessions.create", { key, agentId: "main" });
        await page.goto(controlUiSessionUrl(urls[index]!, key));
        await waitForControlUiGatewayReady(page);
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        await pane
          .getByRole("textbox", { name: "Chat composer", exact: true })
          .fill("Get then read run receipts for job " + job.id);
        await pane.getByRole("button", { name: "Send message", exact: true }).click();
        await pane
          .locator(".chat-bubble")
          .getByText("Receipt proof " + phase + " complete.", { exact: true })
          .waitFor({ timeout: 30000 });
        expect(phaseCalls).toBe(3);
      }
      const adminInputs = JSON.stringify(
        providerInputs.filter((value) => (value as { phase: string }).phase === "admin"),
      );
      const deniedInputs = JSON.stringify(
        providerInputs.filter((value) => (value as { phase: string }).phase === "nonowner"),
      );
      expect(adminInputs).toContain("Receipt proof receipt complete.");
      expect(deniedInputs).toContain("Automation not found");
      expect(deniedInputs).not.toContain("Receipt proof receipt complete.");
    } finally {
      await writeFile(
        path.join(artifacts, "provider-tool-results.json"),
        JSON.stringify(providerInputs, null, 2),
      );
    }
  }, 150000);
});
