import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { AuditRunInspectResult } from "../../../packages/gateway-protocol/src/schema/audit-run.js";
import type { AuditEvent } from "../../../packages/gateway-protocol/src/schema/audit.ts";
import type {
  CronJob,
  CronRunLogEntry,
} from "../../../packages/gateway-protocol/src/schema/cron.types.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../../src/agents/agent-run-terminal-outcome.ts";
import { escapeMarkdownText } from "../../../src/shared/text/escape-markdown.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { SessionsListResult } from "../api/types.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { withControlUiRunInspector } from "../test-helpers/control-ui-run-inspector.ts";
import { observeBackgroundWorkRpc } from "./background-work.real-gateway.test-support.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  quietFixture as fixture,
  startQuietProvider,
  type QuietOutcome,
} from "./quiet-automations.real-gateway.test-support.ts";

// One real producer-to-browser regression. Optional external inference is explicitly opt-in.
const baselineRoot = process.env.OPENCLAW_QUIET_PROOF_BASELINE_ROOT;
const live = !baselineRoot && process.env.OPENCLAW_QUIET_PROOF_LIVE === "1";
const captureUiProof =
  Boolean(baselineRoot) || live || process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiRoot = path.resolve(baselineRoot ?? ".", "dist/control-ui");
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
let provider: Awaited<ReturnType<typeof startQuietProvider>>;
let artifacts: string;
const proof: Record<string, unknown> = {
  gateway: "real isolated built Gateway",
  websocketInterception: false,
  provider: "deterministic loopback OpenAI Responses fixture",
  liveRequested: live,
  complete: false,
  runs: [],
  settlements: [],
  screenshots: [],
};
const save = () =>
  fs.writeFile(path.join(artifacts, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
const suite = createControlUiE2eSuite({
  name: "Quiet automation real Gateway boundary",
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
    artifacts = createControlUiE2eArtifactDir(
      baselineRoot ? "quiet-automations-before" : "quiet-automations-after",
    );
    proof.baseline = Boolean(baselineRoot);
    await fs.access(path.join(uiRoot, "index.html"));
    provider = await startQuietProvider({ baseline: Boolean(baselineRoot) });
    const cleanup = () =>
      runQaGatewayFixture(
        async () => {
          await instance?.cleanup();
          proof.gatewayStopped = !instance?.child;
        },
        async () => {
          await provider.stop();
          proof.providerStopped = true;
        },
        save,
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "quiet-automations",
        entrypoint: ["dist/index.js"],
        ...(baselineRoot ? { cwd: baselineRoot } : {}),
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: undefined,
          // Only this disposable loopback provider bypasses an inherited host proxy.
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
          logging: {
            file: "${OPENCLAW_STATE_DIR}/quiet-proof.log",
            audit: { executionIdentity: true },
          },
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
              modelPolicy: { allow: ["quiet-fixture/*", ...(live ? ["openai/gpt-4.1-mini"] : [])] },
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
              ...(live
                ? {
                    openai: {
                      api: "openai-responses",
                      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                      baseUrl: "https://api.openai.com/v1",
                      models: [{ id: "gpt-4.1-mini", name: "GPT-4.1 mini" }],
                    },
                  }
                : {}),
            },
          },
        },
      });
      instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("public-workspace");
      await instance.startGateway();
      proof.pid = instance.child?.pid;
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
async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return client.request<T>(method, params, { timeoutMs: 90_000 });
}
async function session() {
  const result = await rpc<SessionsListResult>("sessions.list", {
    includeLastMessage: true,
    limit: 100,
  });
  const row = result.sessions.find((value) => value.key === fixture.key);
  expect(row).toBeDefined();
  return row!;
}
async function openAutomations(page: Page) {
  const details = await openChatDetails(page);
  const mobileEntry = details.locator('[data-details-destination="automations"]');
  if (await mobileEntry.isVisible()) {
    await mobileEntry.click();
    await details.locator(".session-automation-mobile__list-row").first().waitFor();
  }
}
async function screenshot(page: Page, name: string, required: string) {
  const body = page.locator("body");
  const text = (await body.textContent()) ?? "";
  for (const secret of [
    instance.gatewayToken,
    instance.hookToken,
    instance.stateDir,
    instance.homeDir,
    "synthetic-quiet-fixture-key",
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(new URL(page.url()).hash).toBe("");
  const target = page
    .locator(
      '.chat-summary__automation, .session-automation-mobile__list-row, .chat-details-mobile-root__entry[data-details-destination="automation"]',
    )
    .filter({ hasText: required, visible: true })
    .getByText(required, { exact: true })
    .first();
  if (!captureUiProof) {
    await waitForControlUiProofSurface(body, [target]);
    if ((page.viewportSize()?.width ?? 1440) < 560) {
      await target.scrollIntoViewIfNeeded();
    }
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, body, [target], {
    animations: "disabled",
    ...((page.viewportSize()?.width ?? 1440) < 560 ? { scrollTo: target } : {}),
  });
  await fs.writeFile(path.join(artifacts, name + ".png"), frame.png);
  (proof.screenshots as string[]).push(name + ".png");
  await save();
}

suite.define(() => {
  it("keeps checks quiet while preserving meaningful status, freshness, visible results and run evidence", async (test) => {
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
        const wire = observeBackgroundWorkRpc(page, signal);
        proof.stage = "create real creator conversation and automation";
        await rpc("sessions.create", {
          key: fixture.key,
          agentId: "main",
          label: "Release readiness",
        });
        await pairControlUiPage(page, cli);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
        await waitForControlUiGatewayReady(page);
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
        await composer.fill(
          "Watch release readiness in this conversation and report only meaningful changes.",
        );
        await pane.getByRole("button", { name: "Send message", exact: true }).click();
        const sent = await wire.waitFor((entry) => entry.request.method === "chat.send");
        expect(sent.response.ok, JSON.stringify(sent.response.error)).toBe(true);
        try {
          await pane
            .locator(".chat-bubble")
            .getByText(fixture.initial, { exact: true })
            .waitFor({ timeout: 30_000 });
        } catch (error) {
          console.error(
            "[quiet-proof] creator failure",
            provider.diagnostics(),
            wire.diagnostics(),
          );
          let diagnostics = instance.logs() + "\n" + ((await pane.textContent()) ?? "");
          for (const secret of [
            instance.gatewayToken,
            instance.hookToken,
            process.env.OPENAI_API_KEY,
          ]) {
            if (secret) {
              diagnostics = diagnostics.replaceAll(secret, "[redacted]");
            }
          }
          await fs.writeFile(path.join(artifacts, "creator-diagnostics.txt"), diagnostics);
          throw error;
        }
        const jobs = await rpc<{ jobs: CronJob[] }>("cron.list", { includeDisabled: true });
        const job = jobs.jobs.find((value) => value.name === fixture.name);
        expect(job, "real agent tool must create the automation").toBeDefined();
        const id = job!.id;
        proof.jobId = id;
        const script = await page.locator('script[type="module"][src]').first().getAttribute("src");
        expect(script?.startsWith("/assets/") && script.endsWith(".js")).toBe(true);
        const served = await (
          await context.request.get(new URL(script!, suite.server.baseUrl).href)
        ).body();
        expect(served.equals(await fs.readFile(path.join(uiRoot, script!.slice(1))))).toBe(true);
        proof.uiAsset = { path: script, sha256: createHash("sha256").update(served).digest("hex") };
        const row = pane.locator(".chat-summary__automation").filter({ hasText: fixture.name });
        // The Summary is the shared desktop/mobile automation presentation owner.
        if (!(await row.isVisible())) {
          await openAutomations(page);
        }
        await row.waitFor();
        const run = async (outcome: QuietOutcome, inspectPending = false) => {
          proof.stage = "run " + outcome;
          provider.next(outcome);
          const execution = rpc<{ run?: CronRunLogEntry }>("cron.run", {
            id,
            mode: "force",
            waitTimeoutMs: 80_000,
          });
          // Own a rejection immediately while inspecting the concurrent browser.
          void execution.catch(() => {});
          await provider.waitStarted(signal);
          try {
            if (inspectPending) {
              const active = await session();
              ((proof.recencyPhases ??= []) as unknown[]).push({
                phase: "provider-held",
                observedAt: Date.now(),
                updatedAt: active.updatedAt,
              });
              await save();
              expect(active.activeRunIds ?? []).toHaveLength(0);
              const startup = await rpc<{ inFlightRun?: unknown }>("chat.history", {
                sessionKey: fixture.key,
                limit: 100,
              });
              expect(startup.inFlightRun).toBeUndefined();
              expect(
                await pane.getByRole("button", { name: "Stop generating", exact: true }).count(),
              ).toBe(0);
              expect(await pane.getByText(fixture.prompt, { exact: false }).count()).toBe(0);
            }
          } finally {
            provider.release();
          }
          const result = await execution;
          expect(result.run, "cron.run must wait for real persisted settlement").toBeDefined();
          (proof.runs as unknown[]).push({ outcome, run: result.run });
          const persisted = await rpc<CronJob>("cron.get", { id });
          const history = await rpc<{ entries: CronRunLogEntry[] }>("cron.runs", {
            id,
            runId: result.run!.runId,
            limit: 1,
          });
          (proof.settlements as unknown[]).push({
            outcome,
            jobState: persisted.state,
            history: history.entries,
          });
          await save();
          return result.run!;
        };
        const first = await run("blocked");
        expect(first.status).toBe("ok");
        await pane.locator(".chat-bubble").getByText(fixture.blocked, { exact: true }).waitFor();
        if (baselineRoot) {
          await run("no_change");
          await run("no_change");
          await screenshot(page, "desktop-blocked-after-quiet-checks", fixture.name);
          await closeChatDetails(page);
          await page.setViewportSize({ width: 390, height: 844 });
          await pane.locator(".agent-chat__header--mobile").waitFor();
          await openAutomations(page);
          await screenshot(page, "mobile-blocked-after-quiet-checks", fixture.name);
          proof.complete = true;
          proof.stage = "baseline capture complete";
          await save();
          return;
        }
        expect(first.result).toMatchObject({ outcome: "blocked", summary: fixture.blocked });
        // Automation rows stay limited to the name and schedule; results live in chat and history.
        expect(await row.textContent()).not.toContain(fixture.blocked);
        expect(await row.textContent()).not.toContain("Checked");
        await expect.poll(async () => (await session()).unread).toBe(false);
        const before = await session();
        expect(before.lastMessagePreview).toContain(fixture.blocked);
        proof.quietDisplayBefore = { unread: before.unread, preview: before.lastMessagePreview };
        proof.recencyPhases = [
          {
            phase: "before-quiet-checks",
            observedAt: Date.now(),
            updatedAt: before.updatedAt,
          },
        ];
        const messageCount = await pane.locator(".chat-bubble").count();
        proof.bubblesBeforeQuiet = await pane.locator(".chat-bubble").allTextContents();
        expect(messageCount).toBeGreaterThan(0);
        const meaningful = (await rpc<CronJob>("cron.get", { id })).state.lastMeaningfulResult;
        for (let index = 0; index < 2; index++) {
          const quiet = await run("no_change", true);
          expect(quiet.status).toBe("ok");
          expect(quiet.result).toEqual(
            index === 0
              ? { outcome: "no_change", summary: fixture.waiting }
              : { outcome: "no_change" },
          );
          expect(quiet.summary).toBeUndefined();
          const latest = await rpc<CronJob>("cron.get", { id });
          expect(latest.state.lastMeaningfulResult).toEqual(meaningful);
          expect(latest.state.lastRunAtMs).toBeGreaterThan(first.runAtMs!);
          proof.priorContext = provider.promptDiagnostics();
          await save();
          expect(provider.receivedPriorMeaningfulResult()).toEqual(meaningful);
          expect(provider.receivedPriorMeaningfulResult()).toMatchObject({
            outcome: "blocked",
            summary: fixture.blocked,
            atMs: expect.any(Number),
          });
          const afterQuiet = await session();
          (proof.recencyPhases as unknown[]).push({
            phase: "quiet-settled",
            observedAt: Date.now(),
            updatedAt: afterQuiet.updatedAt,
          });
          await save();
          expect(afterQuiet.updatedAt).toBe(before.updatedAt);
          expect(afterQuiet.unread).toBe(before.unread);
          expect(afterQuiet.lastMessagePreview).toBe(before.lastMessagePreview);
          proof.quietDisplayAfter = {
            unread: afterQuiet.unread,
            preview: afterQuiet.lastMessagePreview,
          };
          proof.bubblesAfterQuiet = await pane.locator(".chat-bubble").allTextContents();
          await save();
          expect(await pane.locator(".chat-bubble").count()).toBe(messageCount);
          expect(await pane.getByText(fixture.prompt, { exact: false }).count()).toBe(0);
          expect(await pane.getByText(fixture.waiting, { exact: true }).count()).toBe(0);
        }
        const beforeTrigger = await rpc<CronJob>("cron.get", { id });
        const providerRequestsBeforeTrigger = provider.requests();
        // Start the first occurrence soon while retaining the trigger's minimum cadence.
        const triggerAnchorMs = Date.now() + 1_000;
        const due = await rpc<CronJob>("cron.update", {
          id,
          patch: {
            schedule: { kind: "every", everyMs: 30_000, anchorMs: triggerAnchorMs },
            trigger: { script: "return { fire: false };" },
          },
        });
        expect(due.state.nextRunAtMs).toEqual(expect.any(Number));
        // Wait for this real scheduled occurrence; force mode intentionally bypasses triggers.
        await delay(Math.max(0, due.state.nextRunAtMs! - Date.now()) + 1, undefined, { signal });
        const triggerRun = await rpc<{ run?: CronRunLogEntry }>("cron.run", {
          id,
          mode: "due",
          waitTimeoutMs: 10_000,
        });
        expect(triggerRun.run).toMatchObject({
          status: "skipped",
          error: "queued manual run skipped: trigger condition not met",
        });
        await expect
          .poll(async () => (await rpc<CronJob>("cron.get", { id })).state.lastTriggerEvalAtMs)
          .toBeGreaterThan(beforeTrigger.state.lastRunAtMs!);
        const afterTrigger = await rpc<CronJob>("cron.get", { id });
        expect(afterTrigger.state.lastRunAtMs).toBe(beforeTrigger.state.lastRunAtMs);
        expect(afterTrigger.state.lastMeaningfulResult).toEqual(meaningful);
        expect(provider.requests()).toBe(providerRequestsBeforeTrigger);
        expect((await session()).updatedAt).toBe(before.updatedAt);
        proof.triggerCheck = {
          evaluatedAtMs: afterTrigger.state.lastTriggerEvalAtMs,
          noModelRequest: true,
          lastPayloadRunUnchanged: true,
        };
        await rpc("cron.update", {
          id,
          patch: { trigger: null, schedule: { kind: "every", everyMs: 3_600_000 }, enabled: true },
        });
        proof.quietChecks = {
          count: 2,
          recencyUnchanged: true,
          messageCountUnchanged: true,
          noActiveProjection: true,
          retainedMeaningfulResult: meaningful,
        };
        await screenshot(page, "desktop-blocked-after-quiet-checks", fixture.name);
        await row.hover();
        await screenshot(page, "desktop-automation-hover", fixture.name);
        await page.keyboard.press("Tab");
        await row.focus();
        expect(await row.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        expect(await row.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe("2px");
        await screenshot(page, "desktop-automation-focus", fixture.name);
        await row.blur();
        await closeChatDetails(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await pane.locator(".agent-chat__header--mobile").waitFor();
        await openAutomations(page);
        await expect
          .poll(() =>
            page
              .locator(
                '.session-automation-mobile__list-row, .chat-details-mobile-root__entry[data-details-destination="automation"]',
              )
              .filter({ hasText: fixture.name, visible: true })
              .textContent(),
          )
          .not.toContain(fixture.blocked);
        await screenshot(page, "mobile-blocked-after-quiet-checks", fixture.name);
        await closeChatDetails(page);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openAutomations(page);
        for (const outcome of ["progress", "done"] as const) {
          const result = await run(outcome);
          expect(result.status).toBe("ok");
          expect(result.result).toMatchObject({ outcome, summary: fixture[outcome] });
          await pane.locator(".chat-bubble").getByText(fixture[outcome], { exact: true }).waitFor();
          expect(await row.textContent()).not.toContain(fixture[outcome]);
        }
        const error = await run("error");
        expect(error.status).toBe("error");
        expect(error.error).toBe(`LLM request rejected: ${escapeMarkdownText(fixture.error)}`);
        // Structured provider failures remain in run history, not announcements.
        expect((await rpc<CronJob>("cron.get", { id })).state.lastMeaningfulResult?.outcome).toBe(
          "done",
        );
        const history = await rpc<{ entries: CronRunLogEntry[] }>("cron.runs", { id, limit: 20 });
        // The six payload runs and the skipped due-trigger check all retain audit history.
        expect(history.entries).toHaveLength(7);
        expect(history.entries.find((entry) => entry.runId === triggerRun.run!.runId)).toEqual(
          triggerRun.run,
        );
        expect(
          history.entries.filter((entry) => entry.result?.outcome === "no_change"),
        ).toHaveLength(2);
        proof.historyPreserved = true;
        expect(error.runId).toBeTruthy();
        // cron.run exposes the request id; Inspector selects the admitted agent execution.
        proof.stage = "discover admitted agent audit run";
        await save();
        const terminalAuditRun = async () => {
          const audit = await rpc<{ events: AuditEvent[] }>("audit.list", {
            sessionKey: fixture.key,
            kind: "agent_run",
            after: error.runAtMs,
            limit: 10,
          });
          proof.auditEvents = audit.events;
          await save();
          return audit.events.find((event) => event.action === "agent.run.finished");
        };
        // Failed terminals retain the retry grace before entering the asynchronous audit writer.
        await expect
          .poll(terminalAuditRun, { timeout: AGENT_RUN_TERMINAL_RETRY_GRACE_MS + 15_000 })
          .toBeDefined();
        const auditRun = (await terminalAuditRun())!;
        proof.stage = "inspect admitted agent identity";
        await save();
        expect(auditRun.sessionId).toBe(error.sessionId);
        const inspection = await rpc<AuditRunInspectResult>("audit.run.inspect", {
          runId: auditRun.runId,
        });
        expect(inspection.identity.state).toBe("present");
        if (inspection.identity.state !== "present") {
          throw new Error("Run Inspector lost the automation execution");
        }
        const executionId = inspection.identity.context.executionId;
        proof.stage = "render admitted agent Run Inspector";
        await save();
        await withControlUiRunInspector(
          context,
          {
            baseUrl: suite.server.baseUrl,
            selector: { kind: "execution", id: executionId },
            preparePage: (inspectorPage) => pairControlUiPage(inspectorPage, cli),
          },
          async (_inspectorPage, inspector) => {
            expect(await inspector.getAttribute("data-execution-id")).toBe(executionId);
            expect(await inspector.getAttribute("data-run-id")).toBe(auditRun.runId);
          },
        );
        proof.inspectorPreserved = {
          requestRunId: error.runId,
          agentRunId: auditRun.runId,
          executionId,
        };
        if (live) {
          proof.stage = "external live provider quiet check";
          expect(
            Boolean(process.env.OPENAI_API_KEY),
            "live proof requires existing managed OPENAI_API_KEY",
          ).toBe(true);
          await rpc("cron.update", {
            id,
            patch: {
              payload: {
                kind: "agentTurn",
                model: "openai/gpt-4.1-mini",
                message:
                  "Live proof task: release readiness has not changed. Use automations record_result with outcome no_change and no summary exactly once, then final reply NO_REPLY. Do not call other tools.",
              },
            },
          });
          const real = await rpc<{ run?: CronRunLogEntry }>("cron.run", {
            id,
            mode: "force",
            waitTimeoutMs: 80_000,
          });
          proof.live = real.run;
          await save();
          expect(real.run?.status).toBe("ok");
          expect(real.run?.result).toEqual({ outcome: "no_change" });
          expect(real.run?.provider).toBe("openai");
          expect(real.run?.model).toBe("gpt-4.1-mini");
        }
        // Reload reconstructs the conversation and automation from persisted Gateway data.
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await pane.locator(".chat-bubble").getByText(fixture.done, { exact: true }).waitFor();
        await openAutomations(page);
        await expect.poll(() => row.textContent()).toContain(fixture.name);
        await expect.poll(() => row.textContent()).toContain("Every 1 hour");
        expect(await row.textContent()).not.toContain(fixture.done);
        proof.complete = true;
        proof.stage = "complete";
        await save();
      },
    });
  }, 240_000);
});
