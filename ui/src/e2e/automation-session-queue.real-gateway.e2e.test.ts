import path from "node:path";
import { expect, it } from "vitest";
import type {
  CronJob,
  CronRunLogEntry,
} from "../../../packages/gateway-protocol/src/schema/cron.types.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  quietFixture as fixture,
  startQuietProvider,
} from "./quiet-automations.real-gateway.test-support.ts";

// One real producer-to-browser regression: a human message sent while a scheduled
// automation owns an existing conversation. Only the provider is scripted.
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
let provider: Awaited<ReturnType<typeof startQuietProvider>>;
const suite = createControlUiE2eSuite({
  name: "Automation-owned conversation queue",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    provider = await startQuietProvider();
    const cleanup = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        () => provider.stop(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "automation-session-queue",
        entrypoint: ["dist/index.js"],
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: undefined,
          NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
            .filter(Boolean)
            .join(","),
          no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
            .filter(Boolean)
            .join(","),
        },
        config: {
          update: { checkOnStart: false },
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          plugins: { allow: [] },
          tools: { profile: "full", codeMode: false, toolSearch: false },
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: "${OPENCLAW_WORKSPACE_DIR}",
              model: "quiet-fixture/agent",
              models: {
                "quiet-fixture/agent": { params: { transport: "sse", openaiWsWarmup: false } },
              },
              modelPolicy: { allow: ["quiet-fixture/*"] },
            },
            entries: { main: { identity: { name: "Release assistant" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "quiet-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-quiet-fixture-key",
                baseUrl: "http://127.0.0.1:" + provider.port + "/v1",
                models: [{ id: "agent", name: "Automation fixture" }],
              },
            },
          },
        },
      });
      instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("public-workspace");
      await instance.startGateway();
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close: cleanup };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, cleanup);
    }
  },
});

async function cli(args: string[]) {
  const result = await instance.cli(args, { timeoutMs: 100_000 });
  expect(result.code, (result.stderr || result.stdout).slice(-4_000)).toBe(0);
  return result.stdout;
}
function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return client.request<T>(method, params, { timeoutMs: 90_000 });
}

suite.define(() => {
  it("shows a human message as queued behind the automation that owns the conversation", async (test) => {
    await suite.runScenario(test, {
      retainedState: () => instance.stateDir,
      run: async (signal) => {
        const artifacts = captureUiProof
          ? createControlUiE2eArtifactDir("automation-session-queue")
          : undefined;
        const context = await suite.newBrowserContext({
          ...createControlUiE2eContextOptions(),
          viewport: { width: 1280, height: 900 },
          colorScheme: "dark",
        });
        await context.addInitScript(() =>
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          ),
        );
        const page = await context.newPage();
        const capture = async (name: string) => {
          if (artifacts) {
            await page.screenshot({ path: path.join(artifacts, name + ".png") });
          }
        };
        await rpc("sessions.create", { key: fixture.key, agentId: "main", label: "Release" });
        await pairControlUiPage(page, cli);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
        await waitForControlUiGatewayReady(page);
        await assertServedUi(page, suite.server.baseUrl);
        const { pane, composer, send, stop } = chatControls(page);
        await composer.fill("Watch release readiness in this conversation.");
        await send.click();
        await pane.locator(".chat-bubble").getByText(fixture.initial, { exact: true }).waitFor();
        await expect.poll(() => stop.count()).toBe(0);
        const job = (await rpc<{ jobs: CronJob[] }>("cron.list", {})).jobs.find(
          (value) => value.name === fixture.name,
        );
        expect(job).toBeDefined();

        // The automation run is held at its first model call while the human writes.
        provider.next("progress");
        const execution = rpc<{ run?: CronRunLogEntry }>("cron.run", {
          id: job!.id,
          mode: "force",
          waitTimeoutMs: 80_000,
        });
        void execution.catch(() => {});
        await provider.waitStarted(signal);
        // Quiet checks stay off the conversation until a human interacts.
        expect(await stop.count()).toBe(0);
        await composer.fill(fixture.human);
        await send.click();
        const queued = pane.locator(".chat-queue__item", { hasText: fixture.human });
        const owner = queued.getByText("Waiting for automation to finish", { exact: true });
        try {
          await queued.waitFor({ timeout: 20_000 });
          await owner.waitFor({ timeout: 20_000 });
        } finally {
          await capture("queued-behind-automation");
        }
        // Queued input is not inference progress: no elapsed timer is attached to it.
        const timer = pane.locator(".chat-working-indicator__elapsed");
        await expect.poll(() => timer.count()).toBe(0);
        expect(await stop.count()).toBe(0);
        // History hydration restores the same queued presentation, not a running turn.
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await owner.waitFor();
        await pane.locator(".chat-bubble").getByText(fixture.initial, { exact: true }).waitFor();
        expect(await timer.count()).toBe(0);
        expect(provider.humanTurns()).toBe(0);

        provider.release();
        const result = await execution;
        expect(result.run?.status).toBe("ok");
        await pane.locator(".chat-bubble").getByText(fixture.progress, { exact: true }).waitFor();
        // The queued human turn runs exactly once after the automation settles.
        await pane
          .locator(".chat-bubble")
          .getByText(fixture.humanReply, { exact: true })
          .waitFor({ timeout: 30_000 });
        await expect.poll(() => queued.count()).toBe(0);
        await expect.poll(() => owner.count()).toBe(0);
        await expect.poll(() => stop.count()).toBe(0);
        expect(provider.humanTurns()).toBe(1);
        await capture("follow-up-answered");
      },
    });
  }, 180_000);
});
