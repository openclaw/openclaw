import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
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
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
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
const providerAuthorizations: (string | undefined)[] = [];
let heldProviderResponse: ServerResponse | undefined;
const suite = createControlUiE2eSuite({
  name: "Human automation ownership through the real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          request.resume().once("end", () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            providerAuthorizations.push(request.headers.authorization);
            if (providerAuthorizations.length === 1) {
              writeToolCall(response, "write", {
                path: path.join(instance.state.workspaceDir, "before-transfer.txt"),
                content: "Authorized before transfer.",
              });
              return;
            }
            if (providerAuthorizations.length === 3) {
              heldProviderResponse = response;
              return;
            }
            writeOpenAiResponsesText(response, {
              text: "Synthetic owner execution completed.",
              messageId: "owner-message",
              responseId: "owner-response",
            });
          });
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
        name: "cron-human-owner",
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
  it("saves and transfers an owned automation, then denies the former owner", async () => {
    const pages: Page[] = [];
    for (let index = 0; index < people.length; index++) {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      await page.goto(new URL("automations", urls[index]).toString());
      await waitForControlUiGatewayReady(page);
      const identity = await evaluateControlUiContext(
        page,
        (app) => app.gateway.snapshot.selfUser?.id,
      );
      expect(identity).toBe(profiles[index]);
      pages.push(page);
    }
    const [admin, alice, bob] = pages as [Page, Page, Page];
    const job = await rpc<CronJob>(admin, "cron.add", {
      name: "Hourly session ping",
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Send the hourly test ping." },
      delivery: { mode: "none" },
    });
    // A successful pre-transfer run proves the provider and credential path are live.
    expect(
      await rpc(admin, "cron.run", { id: job.id, mode: "force", waitTimeoutMs: 30_000 }),
    ).toMatchObject({ run: { status: "ok" } });
    expect(providerAuthorizations).toEqual(Array(2).fill("Bearer synthetic-owner-test"));
    expect(
      await readFile(path.join(instance.state.workspaceDir, "before-transfer.txt"), "utf8"),
    ).toBe("Authorized before transfer.");
    // Hold a real provider response while an already-paused job is force-running.
    // Transfer must retire that admitted occurrence before its next tool or model I/O.
    const activeRun = rpc(admin, "cron.run", { id: job.id, mode: "force", waitTimeoutMs: 30_000 });
    await expect.poll(() => heldProviderResponse !== undefined).toBe(true);
    await rpc(admin, "cron.update", { id: job.id, patch: { ownerProfileId: profiles[1] } });
    writeToolCall(heldProviderResponse!, "write", {
      path: path.join(instance.state.workspaceDir, "after-transfer.txt"),
      content: "Must not be written after transfer.",
    });
    expect(await activeRun).toMatchObject({
      run: { status: "error", error: expect.stringContaining("ownership transferred") },
    });
    await expect(
      readFile(path.join(instance.state.workspaceDir, "after-transfer.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(providerAuthorizations).toEqual(Array(3).fill("Bearer synthetic-owner-test"));
    for (const [index, page] of pages.entries()) {
      await page.goto(new URL("automations?job=" + job.id, urls[index]).toString());
      await waitForControlUiGatewayReady(page);
      await page.locator("#cron-name").waitFor();
    }
    expect(await alice.locator("#cron-name").isDisabled()).toBe(false);
    expect(await bob.locator("#cron-name").isDisabled()).toBe(true);
    expect(await admin.locator("#cron-owner-profile-id").isDisabled()).toBe(false);
    const ownerPicker = alice.locator("openclaw-select-picker:has(#cron-owner-profile-id)");
    expect(await ownerPicker.textContent()).toContain("Alice Owner");
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const artifacts = createControlUiE2eArtifactDir("automation-owner-after");
      const surface = alice.locator(".cron-page");
      const frame = await takeControlUiScreenshotFrame(
        alice,
        surface,
        [alice.locator("#cron-name"), ownerPicker],
        { viewport: { width: 1440, height: 1000 }, animations: "disabled" },
      );
      await writeFile(path.join(artifacts, "owner-editor.png"), frame.png);
    }
    await alice.locator("#cron-name").fill("Hourly ping edited by Alice");
    await alice.locator('[data-test-id="cron-submit"]').click();
    await expect
      .poll(async () => (await rpc<CronJob>(admin, "cron.get", { id: job.id })).name)
      .toBe("Hourly ping edited by Alice");
    await selectPickerValue(ownerPicker, profiles[2]!);
    await alice.locator('[data-test-id="cron-submit"]').click();
    await expect
      .poll(async () => (await rpc<CronJob>(admin, "cron.get", { id: job.id })).ownerProfileId)
      .toBe(profiles[2]);
    const transferred = await rpc<CronJob>(admin, "cron.get", { id: job.id });
    expect(transferred.enabled).toBe(false);
    await expect.poll(() => alice.locator("#cron-name").isDisabled()).toBe(true);
    await expect(
      rpc(alice, "cron.update", { id: job.id, patch: { name: "Former owner cannot edit" } }),
    ).rejects.toThrow();
    await bob.reload();
    await waitForControlUiGatewayReady(bob);
    await expect.poll(() => bob.locator("#cron-name").isDisabled()).toBe(false);
    await bob.locator("#cron-name").fill("Hourly ping edited by Bob");
    await bob.locator('[data-test-id="cron-submit"]').click();
    await expect
      .poll(async () => (await rpc<CronJob>(admin, "cron.get", { id: job.id })).name)
      .toBe("Hourly ping edited by Bob");
    await expect(rpc(alice, "cron.run", { id: job.id, mode: "force" })).rejects.toThrow();
    const sharedSession = "agent:main:owner-transfer-provider-proof";
    await rpc(bob, "sessions.create", { key: sharedSession, agentId: "main" });
    for (const sessionTarget of ["isolated", `session:${sharedSession}`]) {
      await rpc(bob, "cron.update", { id: job.id, patch: { sessionTarget } });
      expect(
        await rpc(bob, "cron.run", { id: job.id, mode: "force", waitTimeoutMs: 30_000 }),
      ).toMatchObject({
        run: { status: "error", error: expect.stringContaining("fresh execution authority") },
      });
      // Check only after the run settles: an enqueue acknowledgment cannot prove no I/O.
      expect(providerAuthorizations).toEqual(Array(3).fill("Bearer synthetic-owner-test"));
    }
  }, 120_000);
});
