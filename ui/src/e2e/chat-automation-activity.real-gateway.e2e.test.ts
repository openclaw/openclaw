import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type {
  GatewayFrame,
  RequestFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { CronJob, CronCompactJob } from "../api/types.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  automationFixture as fixture,
  createAutomationInstance,
  startAutomationProvider,
} from "./chat-automation-activity.real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

// Expensive acceptance: real timer → agent → automations tool → persisted history → built UI.
// No mocked WebSocket, seeded messages, or external-provider inference.
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startAutomationProvider>>;
let directory: string;
const proof: Record<string, unknown> = {
  complete: false,
  provider: "deterministic loopback OpenAI Responses (not external-model live proof)",
  websocketInterception: false,
};
const save = () =>
  fs.writeFile(path.join(directory, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
const suite = createControlUiE2eSuite({
  name: "Compact automation activity through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    directory = createControlUiE2eArtifactDir(
      "automation-real-gateway",
      path.resolve(".openclaw/tmp/automation-real-proof"),
    );
    await fs.access("dist/control-ui/index.html");
    provider = await startAutomationProvider();
    const close = () =>
      runQaGatewayFixture(
        async () => {
          if (instance) {
            const redact = (value: string) =>
              value
                .replaceAll(instance.gatewayToken, "[synthetic token]")
                .replaceAll(instance.hookToken, "[synthetic token]");
            await fs.writeFile(path.join(directory, "gateway.log"), redact(instance.logs()));
            await instance.cleanup();
            proof.gatewayStopped = !instance.child;
          }
        },
        async () => {
          await provider.stop();
          proof.providerStopped = true;
        },
        save,
      );
    try {
      instance = await createAutomationInstance(provider.port, directory);
      await instance.startGateway();
      proof.gatewayPid = instance.child?.pid;
      proof.profile = instance.env.OPENCLAW_PROFILE;
      proof.canonicalLauncher = "pnpm openclaw --profile <disposable-profile>";
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, close);
    }
  },
});
async function cli(args: string[]) {
  const result = await instance.cli(args, { execPath: "pnpm" });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}
async function rpc<T>(method: string, params: object): Promise<T> {
  return JSON.parse(
    await cli(["gateway", "call", method, "--json", "--params", JSON.stringify(params)]),
  );
}
async function capture(page: Page, name: string) {
  const activity = page.locator(".chat-automation-activity");
  const text = (await page.locator("body").textContent()) ?? "";
  for (const secret of [
    instance.gatewayToken,
    instance.hookToken,
    instance.stateDir,
    "synthetic-automation-fixture-key",
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.locator(".community-invite-card:visible").count()).toBe(0);
  const frame = await takeControlUiScreenshotFrame(
    page,
    page.locator(".chat-thread"),
    [activity.locator(":scope > summary")],
    { animations: "disabled", elements: [activity.locator(":scope > summary")] },
  );
  await fs.writeFile(path.join(directory, name + ".png"), frame.png);
  await fs.writeFile(path.join(directory, name + "-row.png"), frame.elements[0]!.png);
  await save();
}

suite.define(() => {
  it("rearms one session-bound job twice, folds real checks, and preserves originals and useful results after reload", async (test) => {
    await suite.runScenario(test, {
      retainedState: () => instance.stateDir,
      run: async (signal) => {
        const context = await suite.newBrowserContext({
          ...createControlUiE2eContextOptions(),
          viewport: { width: 1440, height: 1000 },
          colorScheme: "dark",
        });
        await context.addInitScript(() =>
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          ),
        );
        const page = await context.newPage();
        const inventory: CronCompactJob[] = [];
        const cronEvents: Array<{ action: string; job: CronJob }> = [];
        proof.cronEvents = cronEvents;
        const pending = new Map<string, RequestFrame>();
        // Passive observation of genuine browser traffic, including authoritative typed job status.
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame: GatewayFrame = JSON.parse(String(payload));
            if (frame.type === "req" && frame.method === "cron.list") {
              pending.set(frame.id, frame);
            }
          });
          socket.on("framereceived", ({ payload }) => {
            const frame: GatewayFrame = JSON.parse(String(payload));
            if (frame.type === "event" && frame.event === "cron") {
              const event = frame.payload as { action: string; job?: CronJob };
              if (event.job) {
                cronEvents.push({ action: event.action, job: event.job });
              }
            }
            if (frame.type === "res" && frame.ok && pending.delete(frame.id)) {
              const result = frame.payload as { jobs: CronCompactJob[] };
              inventory.push(...result.jobs);
            }
          });
        });
        const failure = () =>
          console.error(
            "[automation-real-gateway]",
            JSON.stringify({
              stage: proof.stage,
              providerRequests: provider.requests(),
              inventory: inventory.slice(-4),
            }),
          );
        signal.addEventListener("abort", failure, { once: true });
        proof.stage = "pair browser and create conversation";
        await rpc("sessions.create", {
          key: fixture.key,
          agentId: "main",
          label: "Museum CI watch acceptance",
        });
        // Canonical source launch can refresh runtime identity, then prepare matching UI
        // assets asynchronously. Gateway /readyz alone does not admit dashboard pairing.
        await expect
          .poll(
            async () => {
              const response = await context.request.get(suite.server.baseUrl);
              return (
                response.status() === 200 &&
                (await response.text()).includes("data-openclaw-control-ui-build-id")
              );
            },
            { timeout: 90_000, interval: 500 },
          )
          .toBe(true);
        await pairControlUiPage(page, cli);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
        await waitForControlUiGatewayReady(page);
        const pane = page.locator(".chat-pane-cache__pane--active");
        const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
        await composer.waitFor();
        const script = await page.locator('script[type="module"][src]').first().getAttribute("src");
        expect(script).toMatch(/^\/assets\/.+\.js$/);
        const asset = await context.request.get(new URL(script!, suite.server.baseUrl).href);
        const served = await asset.body();
        expect(
          served.equals(await fs.readFile(path.join("dist/control-ui", script!.slice(1)))),
        ).toBe(true);
        proof.uiAsset = { path: script, sha256: createHash("sha256").update(served).digest("hex") };

        proof.stage = "schedule real at job (not forced/manual execution)";
        const created = await rpc<CronJob>("cron.add", {
          name: fixture.name,
          agentId: "main",
          sessionKey: fixture.key,
          enabled: true,
          deleteAfterRun: false,
          schedule: { kind: "at", at: new Date(Date.now() + 2_000).toISOString() },
          sessionTarget: "session:" + fixture.key,
          wakeMode: "now",
          payload: { kind: "agentTurn", message: fixture.prompt },
          delivery: { mode: "none" },
        });
        proof.jobId = created.id;
        expect(created.sessionTarget).toBe("session:" + fixture.key);
        const activity = page.locator(".chat-automation-activity");
        const status = activity.locator(".chat-automation-activity__status");
        await expect.poll(() => provider.toolResults.length, { timeout: 35_000 }).toBe(2);
        proof.toolResults = provider.toolResults;
        const generatedHistory = await rpc<{ messages: unknown[] }>("chat.history", {
          sessionKey: fixture.key,
          agentId: "main",
          limit: 100,
        });
        await fs.writeFile(
          path.join(directory, "generated-history.json"),
          JSON.stringify(generatedHistory, null, 2),
        );
        await fs.writeFile(
          path.join(directory, "generated-transcript.txt"),
          (await pane.locator(".chat-thread").textContent()) ?? "",
        );
        await page.screenshot({ path: path.join(directory, "generated-transcript.png") });
        await save();
        await expect.poll(() => activity.count()).toBe(1);
        await expect.poll(() => status.textContent()).toContain("Scheduled");
        await expect
          .poll(
            () =>
              new Set(
                cronEvents
                  .filter(
                    ({ job }) =>
                      job.id === created.id &&
                      job.state.nextRunAtMs != null &&
                      job.state.runningAtMs === undefined &&
                      job.state.lastRunStatus === "ok",
                  )
                  .map(({ job }) => job.state.lastRunAtMs),
              ).size,
          )
          .toBeGreaterThanOrEqual(2);
        const scheduled = cronEvents.findLast(
          ({ job }) =>
            job.id === created.id &&
            job.state.nextRunAtMs != null &&
            job.state.runningAtMs === undefined,
        )!.job;
        proof.scheduled = scheduled;
        proof.toolResults = provider.toolResults;
        expect(scheduled.enabled).toBe(true);
        expect(scheduled.state.lastRunStatus).toBe("ok");
        expect(scheduled.state.nextRunAtMs! - scheduled.state.lastRunAtMs!).toBeGreaterThanOrEqual(
          fixture.delayMs,
        );
        await capture(page, "scheduled-two-checks");

        proof.stage = "third real timer execution and authoritative running status";
        await provider.waitForThird(signal);
        await expect.poll(() => status.textContent()).toContain("Checking now");
        await expect
          .poll(() =>
            cronEvents.some(
              ({ job }) => job.id === created.id && job.state.runningAtMs !== undefined,
            ),
          )
          .toBe(true);
        await capture(page, "checking-third");
        provider.finishThird();
        await expect.poll(() => status.textContent()).toContain("Paused");
        const finished = await rpc<CronJob>("cron.get", { id: created.id });
        expect(finished).toMatchObject({
          id: created.id,
          enabled: false,
          state: { lastRunStatus: "ok" },
        });
        expect(finished.state.nextRunAtMs).toBeUndefined();
        proof.finished = finished;
        expect(provider.requests()).toBe(5);

        proof.stage = "reload durable original checks";
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await expect.poll(() => activity.count()).toBe(1);
        await expect.poll(() => status.textContent()).toContain("Paused");
        expect(await activity.getAttribute("open")).toBeNull();
        await activity.locator(":scope > summary").click();
        await expect
          .poll(() => activity.locator(".chat-automation-activity__count").textContent())
          .toContain("3");
        await expect
          .poll(() => activity.getByText(fixture.prompt, { exact: false }).count())
          .toBe(3);
        await expect.poll(() => activity.locator(".chat-tool-row").count()).toBe(2);
        const recordedOutcomes = page.getByText("Interrupted", { exact: true });
        expect(await recordedOutcomes.count()).toBe(2);
        expect(
          await recordedOutcomes.evaluateAll((nodes) =>
            nodes.every((node) => node.closest(".chat-automation-activity")),
          ),
        ).toBe(true);
        await capture(page, "reloaded-originals");
        const history = await rpc<{ messages: unknown[] }>("chat.history", {
          sessionKey: fixture.key,
          agentId: "main",
          limit: 100,
        });
        const inputs = history.messages
          .map(asNullableRecord)
          .filter((message) => asNullableRecord(message?.provenance)?.sourceTool === "cron");
        expect(inputs).toHaveLength(3);
        for (const input of inputs) {
          expect(input!.provenance).toMatchObject({
            kind: "internal_system",
            sourceTool: "cron",
            jobId: created.id,
            sourceSessionKey: fixture.key,
          });
          expect(JSON.stringify(input!.content)).toContain(fixture.prompt);
        }
        proof.durableInputs = inputs;
        await fs.writeFile(path.join(directory, "history.json"), JSON.stringify(history, null, 2));

        proof.stage = "useful final remains outside compact automation history";
        await activity.locator(":scope > summary").click();
        await composer.fill(fixture.question);
        await pane.getByRole("button", { name: "Send message", exact: true }).click();
        const answer = pane.locator(".chat-text").getByText(fixture.answer, { exact: true });
        await answer.waitFor();
        expect(
          await answer.evaluate((element) => element.closest(".chat-automation-activity") === null),
        ).toBe(true);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await answer.waitFor();
        expect(
          await answer.evaluate((element) => element.closest(".chat-automation-activity") === null),
        ).toBe(true);
        await expect.poll(() => activity.count()).toBe(1);
        await capture(page, "useful-final-after-reload");
        proof.providerRequests = provider.requests();
        expect(provider.requests()).toBe(6);
        proof.complete = true;
        proof.stage = "complete";
        await save();
        signal.removeEventListener("abort", failure);
      },
    });
  }, 120_000);
});
