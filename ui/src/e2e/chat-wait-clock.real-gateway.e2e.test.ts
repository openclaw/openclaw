import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../../scripts/lib/local-build-metadata-paths.mts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { observeBackgroundWorkRpc } from "./background-work.real-gateway.test-support.ts";
import {
  createWaitClockInstance,
  startWaitClockProvider,
  waitClockFixture as fixture,
} from "./chat-wait-clock.real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

// Product E2E: one actual native visible child and three parent turns, not an external-provider live test.
// The exact same assertions run against baseline and candidate asset roots.
const uiRoot = path.resolve(process.env.OPENCLAW_UI_E2E_WAIT_CLOCK_UI_ROOT || "dist/control-ui");
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startWaitClockProvider>>;
let artifactDir: string;
const screenshots: string[] = [];
const proof: Record<string, unknown> = {
  mode: "strict-regression",
  gateway: "real isolated Gateway and Chromium; native visible child registry",
  provider: "scripted loopback OpenAI Responses transport; NOT external-provider live proof",
  websocketInterception: false,
  screenshots,
  complete: false,
};
const saveProof = () =>
  fs.writeFile(path.join(artifactDir, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
const suite = createControlUiE2eSuite({
  name: "Wait clocks through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    artifactDir = createControlUiE2eArtifactDir("wait-clock-" + path.basename(uiRoot));
    // No implicit runtime build, Vite server or Gateway substitution.
    await Promise.all(
      [
        "dist/index.js",
        "dist/" + BUILD_STAMP_FILE,
        "dist/" + RUNTIME_POSTBUILD_STAMP_FILE,
        path.join(uiRoot, "index.html"),
      ].map((file) => fs.access(file)),
    );
    provider = await startWaitClockProvider();
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
        saveProof,
      );
    try {
      instance = await createWaitClockInstance(provider.port, uiRoot);
      await instance.startGateway();
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close: cleanup };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, cleanup);
    }
  },
});

async function runCli(args: string[]) {
  const result = await instance.cli(args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}
async function call(method: string, params: Record<string, unknown>) {
  return JSON.parse(
    await runCli(["gateway", "call", method, "--json", "--params", JSON.stringify(params)]),
  );
}
async function rows() {
  const result: SessionsListResult = await call("sessions.list", { agentId: "main", limit: 50 });
  const parent = result.sessions.find((row) => row.key === fixture.key);
  const childKey = provider.receipts.find((receipt) => receipt.tool === "sessions_spawn")?.result
    .childSessionKey;
  const child = result.sessions.find((row) => row.key === childKey);
  expect(parent).toBeDefined();
  expect(child).toBeDefined();
  return { parent: parent!, child: child! };
}
function lifecycle(row: GatewaySessionRow) {
  return {
    key: row.key,
    lastRunId: row.lastRunId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    status: row.status,
    hasActiveSubagentRun: row.hasActiveSubagentRun,
  };
}
function assertWaitLifecycle(parent: GatewaySessionRow, child: GatewaySessionRow) {
  expect(parent.startedAt).toBeGreaterThan(0);
  expect(parent.endedAt).toBeGreaterThanOrEqual(parent.startedAt!);
  expect(parent.hasActiveSubagentRun).toBe(true);
  expect(child.key).toMatch(/^agent:main:dashboard:/);
  expect(child.startedAt).toBeGreaterThan(0);
  expect(child.endedAt).toBeUndefined();
  expect(provider.childIsRunning()).toBe(true);
}
async function clocks(parent: Locator) {
  return parent.locator(".chat-working-indicator__elapsed").evaluateAll((elements) =>
    elements.map((element) => ({
      startMs: (element as HTMLElementTagNameMap["openclaw-elapsed-time"]).startMs,
      text: element.textContent?.trim() ?? "",
      source: "transcript",
    })),
  );
}
function assertClocks(measured: Awaited<ReturnType<typeof clocks>>, endedAt: number) {
  expect(measured.length).toBeGreaterThan(0);
  for (const clock of measured) {
    expect(clock.startMs, clock.source + " must use the persisted latest parent end").toBe(endedAt);
    expect(clock.text).not.toBe("");
    expect(clock.text).not.toMatch(/\d{4,}|[dh]/u);
    expect(Date.now() - clock.startMs!).toBeLessThan(120_000);
  }
}
async function capture(page: Page, parent: Locator, name: string, content: Locator[]) {
  const text = (await page.locator("body").textContent()) ?? "";
  for (const secret of [
    instance.gatewayToken,
    instance.hookToken,
    instance.homeDir,
    instance.stateDir,
    "synthetic-wait-fixture-key",
  ]) {
    expect(text.includes(secret), "capture contains private fixture data").toBe(false);
  }
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.locator(".community-invite-card:visible").count()).toBe(0);
  const frame = await takeControlUiScreenshotFrame(page, parent, content, {
    animations: "disabled",
  });
  await fs.writeFile(path.join(artifactDir, name + ".png"), frame.png);
  screenshots.push(name + ".png");
  await saveProof();
}

suite.define(() => {
  it("uses the latest settled parent clock across update and reload until its visible child completes", async (test) => {
    const started = performance.now();
    await suite.runScenario(test, {
      retainedState: () => instance.stateDir,
      run: async (signal) => {
        const context = await suite.newBrowserContext({
          ...createControlUiE2eContextOptions(),
          viewport: { width: 1440, height: 1000 },
          colorScheme: "dark",
        });
        await context.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
        });
        const page = await context.newPage();
        const wire = observeBackgroundWorkRpc(page, signal);
        try {
          proof.stage = "create parent and pair browser";
          await call("sessions.create", {
            key: fixture.key,
            agentId: "main",
            label: fixture.label,
          });
          await pairControlUiPage(page, runCli);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
          await waitForControlUiGatewayReady(page);
          const parent = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          const composer = parent.getByRole("textbox", { name: "Chat composer", exact: true });
          await composer.waitFor();
          const script = await page
            .locator('script[type="module"][src]')
            .first()
            .getAttribute("src");
          expect(script).toMatch(/^\/assets\/.+\.js$/);
          const asset = await context.request.get(new URL(script!, suite.server.baseUrl).href);
          expect(asset.ok()).toBe(true);
          const served = await asset.body();
          expect(served.equals(await fs.readFile(path.join(uiRoot, script!.slice(1))))).toBe(true);
          proof.uiAsset = {
            path: script,
            sha256: createHash("sha256").update(served).digest("hex"),
          };
          const send = async (message: string) => {
            const before = wire.completed.length;
            await composer.fill(message);
            // A yielded parent still owns an active child; its primary action may say Steer.
            await parent.locator(".chat-send-btn--send").click();
            const rpc = await wire.waitFor((entry) => entry.request.method === "chat.send", before);
            expect(rpc.response.ok, JSON.stringify(rpc.response.error)).toBe(true);
          };
          const waiting = parent.locator(".chat-working-indicator");
          proof.stage = "actual visible child launch and initial parent yield";
          await send(fixture.initialPrompt);
          await expect.poll(() => provider.requests.length).toBeGreaterThan(0);
          await provider.waitForChild(signal);
          await expect.poll(async () => (await rows()).parent.endedAt ?? 0).toBeGreaterThan(0);
          await waiting.waitFor();
          expect(await parent.locator(".agent-chat__composer-run-status").count()).toBe(0);
          const initial = await rows();
          assertWaitLifecycle(initial.parent, initial.child);
          const initialHistory: ChatHistoryResult = await call("chat.history", {
            sessionKey: fixture.key,
            limit: 50,
          });
          expect(JSON.stringify(initialHistory.messages)).toContain("yielded");
          proof.initial = {
            parent: lifecycle(initial.parent),
            child: lifecycle(initial.child),
            clocks: await clocks(parent),
          };

          proof.stage = "parent update while original child continues";
          await send(fixture.updatePrompt);
          await expect
            .poll(async () => (await rows()).parent.endedAt ?? 0)
            .toBeGreaterThan(initial.parent.endedAt!);
          const updateReply = parent
            .getByRole("paragraph")
            .filter({ hasText: fixture.updateReply });
          await expect.poll(() => updateReply.count()).toBe(1);
          await updateReply.waitFor();
          await waiting.waitFor();
          await provider.check();
          const updated = await rows();
          assertWaitLifecycle(updated.parent, updated.child);
          expect(updated.parent.startedAt).toBeGreaterThan(initial.parent.endedAt!);
          expect(updated.parent.endedAt).toBeGreaterThan(initial.parent.endedAt!);
          expect(wire.completed.filter((rpc) => rpc.request.method === "chat.send")).toHaveLength(
            2,
          );
          expect(updated.child.startedAt).toBe(initial.child.startedAt);
          const updatedClocks = await clocks(parent);
          proof.updated = {
            parent: lifecycle(updated.parent),
            child: lifecycle(updated.child),
            clocks: updatedClocks,
          };
          proof.toolReceipts = provider.receipts;
          await capture(page, parent, "after-parent-update", [
            waiting,
            parent.getByRole("paragraph").filter({ hasText: fixture.updateReply }),
          ]);

          proof.stage = "reload persisted parent wait";
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await waiting.waitFor();
          // Reload can hydrate with chat.history.delta; use a fresh public history RPC
          // to independently bind the displayed clock to the persisted session row.
          const history: ChatHistoryResult = await call("chat.history", {
            sessionKey: fixture.key,
            limit: 50,
          });
          const reloaded = await rows();
          assertWaitLifecycle(reloaded.parent, reloaded.child);
          expect(reloaded.parent.startedAt).toBe(updated.parent.startedAt);
          expect(reloaded.parent.endedAt).toBe(updated.parent.endedAt);
          expect(reloaded.child.startedAt).toBe(initial.child.startedAt);
          expect(history.sessionInfo).toBeDefined();
          expect(history.sessionInfo!.endedAt).toBe(updated.parent.endedAt);
          const reloadedClocks = await clocks(parent);
          proof.reloaded = {
            parent: lifecycle(reloaded.parent),
            child: lifecycle(reloaded.child),
            clocks: reloadedClocks,
            historySessionInfo: history.sessionInfo ? lifecycle(history.sessionInfo) : null,
          };
          await capture(page, parent, "after-reload", [
            waiting,
            parent.getByRole("paragraph").filter({ hasText: fixture.updateReply }),
          ]);
          assertClocks(updatedClocks, updated.parent.endedAt!);
          assertClocks(reloadedClocks, updated.parent.endedAt!);
          expect(reloadedClocks.map((clock) => clock.startMs)).toEqual(
            updatedClocks.map((clock) => clock.startMs),
          );

          proof.stage = "actual child completion and parent resume";
          provider.releaseChild();
          await parent.getByRole("paragraph").filter({ hasText: fixture.resumedReply }).waitFor();
          await waiting.waitFor({ state: "hidden" });
          const completed = await rows();
          expect(completed.parent.hasActiveSubagentRun ?? false).toBe(false);
          expect(completed.parent.startedAt).toBeGreaterThan(updated.parent.endedAt!);
          expect(completed.parent.endedAt).toBeGreaterThanOrEqual(completed.parent.startedAt!);
          expect(completed.child.endedAt).toBeGreaterThanOrEqual(initial.child.startedAt!);
          expect(await clocks(parent)).toEqual([]);
          expect(provider.parentRequests()).toBe(5);
          await provider.check();
          proof.completed = {
            parent: lifecycle(completed.parent),
            child: lifecycle(completed.child),
            parentRequests: provider.parentRequests(),
          };
          proof.complete = true;
          proof.stage = "complete";
        } finally {
          proof.providerRequests = provider.requests;
          let logs = instance.logs();
          for (const secret of [
            instance.gatewayToken,
            instance.hookToken,
            instance.homeDir,
            instance.stateDir,
            "synthetic-wait-fixture-key",
          ]) {
            logs = logs.replaceAll(secret, "[fixture-private]");
          }
          await fs.writeFile(path.join(artifactDir, "gateway.private.log"), logs);
          proof.testTimeMs = Math.round(performance.now() - started);
          proof.toolReceipts = provider.receipts;
          await saveProof();
        }
      },
    });
  }, 120_000);
});
