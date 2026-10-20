import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type {
  SessionsProcessesListResult,
  SessionsProcessesStopResult,
} from "../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  backgroundWorkFixture as fixture,
  createBackgroundWorkInstance,
  observeBackgroundWorkRpc,
  startBackgroundWorkProvider,
  type BackgroundWorkRpc,
} from "./background-work.real-gateway.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

// Expensive boundary proof: one isolated Gateway and one actual exec/subagent pair.
// This is NOT external-provider live proof; only the loopback provider is scripted.
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startBackgroundWorkProvider>>;
let artifactDir: string;
const screenshots: string[] = [];
const proof: Record<string, unknown> = {
  provider: "loopback OpenAI Responses fixture; no external live API",
  gateway: "real isolated Gateway serving dist/control-ui",
  websocketInterception: false,
  screenshots,
  complete: false,
};

async function saveProof() {
  await fs.writeFile(path.join(artifactDir, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
}

const suite = createControlUiE2eSuite({
  name: "Independent background work panels through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    artifactDir = createControlUiE2eArtifactDir("background-work-real-gateway");
    // Parent prepares built runtime/UI; never substitute a Vite/mock Gateway here.
    await fs.access("dist/control-ui/index.html");
    provider = await startBackgroundWorkProvider();
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
      instance = await createBackgroundWorkInstance(provider.port);
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

function paramsOf(rpc: BackgroundWorkRpc): Record<string, unknown> {
  return rpc.request.params as Record<string, unknown>;
}

function payloadOf<T = unknown>(rpc: BackgroundWorkRpc): T {
  expect(rpc.response.ok, JSON.stringify(rpc.response.error)).toBe(true);
  return rpc.response.payload as T;
}

const button = (surface: Page | Locator, name: string) =>
  surface.getByRole("button", { name, exact: true });

function recordRpc(key: string, rpc: BackgroundWorkRpc) {
  proof[key] = {
    method: rpc.request.method,
    params: paramsOf(rpc),
    response: rpc.response.payload,
    ok: rpc.response.ok,
  };
}

async function capture(page: Page, name: string, focus: Locator) {
  await focus.waitFor({ state: "visible" });
  expect(
    await focus.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth + 1 &&
        rect.bottom <= innerHeight + 1
      );
    }),
    name + " interaction must fit the viewport",
  ).toBe(true);
  const visibleText = (await page.locator("body").textContent()) ?? "";
  // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText separately proves rendered visible text.
  const renderedText = await page.locator("body").innerText();
  // Synthetic content only. Never retain handoffs, fixture secrets or private fixture paths.
  for (const [category, secret] of [
    ["gatewayToken", instance.gatewayToken],
    ["hookToken", instance.hookToken],
    ["stateDir", instance.stateDir],
    ["homeDir", instance.homeDir],
    ["fixtureKey", "synthetic-background-fixture-key"],
  ] as const) {
    expect(
      visibleText.includes(secret),
      `${category}: visible-text-match=${renderedText.includes(secret)}`,
    ).toBe(false);
  }
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.locator(".community-invite-card:visible").count()).toBe(0);
  await page.screenshot({ path: path.join(artifactDir, name + ".png") });
  screenshots.push(name + ".png");
  await saveProof();
}

async function runBackgroundWork(signal: AbortSignal) {
  const context = await suite.newBrowserContext({
    ...createControlUiE2eContextOptions(),
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    // Real-Gateway contexts do not install the mock helper that seeds this preference.
    const key = "openclaw:control-ui:community-invite:v2";
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify({ dismissedAtMs: 1770000000000 }));
    }
  });
  const page = await context.newPage();
  const wire = observeBackgroundWorkRpc(page, signal);
  const waitForPayload = async <T>(
    method: string,
    matches: (payload: T | undefined, rpc: BackgroundWorkRpc) => boolean,
    after = 0,
  ) =>
    payloadOf<T>(
      await wire.waitFor(
        (rpc) =>
          rpc.request.method === method && matches(rpc.response.payload as T | undefined, rpc),
        after,
      ),
    );
  // The scenario aborts before closing the page, including native test timeouts.
  const logFailure = () =>
    console.error(
      "[background-work-real-gateway] failure",
      JSON.stringify({
        stage: proof.stage,
        parentRequests: provider.parentRequests(),
        parentPending: provider.parentIsPending(),
        processOpen: provider.processIsOpen(),
        rpc: wire.diagnostics(),
      }),
    );
  signal.addEventListener("abort", logFailure, { once: true });
  proof.stage = "create parent and pair browser";
  await runCli([
    "gateway",
    "call",
    "sessions.create",
    "--json",
    "--params",
    JSON.stringify({
      key: fixture.key,
      agentId: "main",
      label: "Background work proof",
    }),
  ]);
  await pairControlUiPage(page, runCli);
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
  await waitForControlUiGatewayReady(page);
  const parent = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
  const composer = parent.getByRole("textbox", { name: "Chat composer", exact: true });
  await composer.waitFor();
  const parentUrl = page.url();
  const script = await page.locator('script[type="module"][src]').first().getAttribute("src");
  expect(script).toMatch(/^\/assets\/.+\.js$/);
  const asset = await context.request.get(new URL(script!, suite.server.baseUrl).href);
  expect(asset.ok()).toBe(true);
  const served = await asset.body();
  const built = await fs.readFile(path.join("dist/control-ui", script!.slice(1)));
  expect(served.equals(built), "served UI must be this checkout's built bundle").toBe(true);
  proof.uiAsset = { path: script, sha256: createHash("sha256").update(served).digest("hex") };

  proof.stage = "start actual background process and native child";
  await composer.fill(
    "Start the background-work fixture process and its native worker, then wait for the worker.",
  );
  await button(parent, "Send message").click();
  const sent = await wire.waitFor((rpc) => rpc.request.method === "chat.send");
  payloadOf(sent);
  const parentRunId = paramsOf(sent).idempotencyKey;
  expect(typeof parentRunId).toBe("string");
  for (const gate of [provider.processConnected, provider.childStarted, provider.parentPending]) {
    await provider.wait(gate, signal);
  }
  await composer.fill(fixture.draft);
  proof.stage = "persist parent draft";
  await waitForCommittedComposerDraft(
    page,
    "chat:v3:" + fixture.key + "\u0000agent:main",
    fixture.draft,
    0,
  );
  const assertParent = async () => {
    expect(page.url()).toBe(parentUrl);
    // Narrow background panels hide the conversation but retain its draft.
    const retainedComposer = parent.getByRole("textbox", {
      name: "Chat composer",
      exact: true,
      includeHidden: true,
    });
    expect(await retainedComposer.inputValue()).toBe(fixture.draft);
    expect(provider.parentIsPending()).toBe(true);
  };

  proof.stage = "independent subagent list and transcript";
  await openChatSidePanelType(page, "Subagents");
  const subagents = parent.locator("openclaw-chat-subagents-panel");
  const childOpen = button(subagents, fixture.childLabel);
  proof.stage = "wait for child row";
  await childOpen.waitFor();
  const childKey = await childOpen
    .locator("xpath=ancestor::*[@data-session-key]")
    .getAttribute("data-session-key");
  expect(childKey).toMatch(/^agent:main:subagent:/);
  proof.stage = "wait for child roster response";
  const roster = await waitForPayload<SessionsListResult>(
    "sessions.list",
    (payload) => payload?.sessions?.some((row) => row.key === childKey) === true,
  );
  const childRow = roster.sessions.find((row) => row.key === childKey)!;
  // Ordinary list rows may omit activeRunIds. Do not invent a singleton to enable row Stop.
  proof.child = {
    key: childKey,
    activeRunIds: childRow.activeRunIds ?? null,
    listStopRendered: (await subagents.locator(".chat-subagents__stop").count()) > 0,
  };
  await capture(page, "desktop-subagents-list", childOpen);
  await childOpen.click();
  const detail = subagents.locator(".chat-subagent-detail");
  proof.stage = "wait for child task transcript";
  await detail.getByText(fixture.childTask, { exact: false }).waitFor();
  proof.stage = "observe child in-flight startup response";
  const history = await waitForPayload<ChatHistoryResult>(
    "chat.startup",
    (payload, rpc) => paramsOf(rpc).sessionKey === childKey && Boolean(payload?.inFlightRun),
  );
  const run = history.inFlightRun!;
  proof.childHistory = { runId: run.runId, sessionAbortable: run.sessionAbortable ?? false };
  expect(run.runId).toBeTruthy();
  expect(run.runId).not.toBe(parentRunId);
  proof.stage = "render child streaming progress";
  provider.writeChildProgress();
  proof.stage = "wait for child progress";
  await detail.getByText(fixture.childText, { exact: true }).waitFor();
  const childStop = button(detail, "Stop generating");
  await childStop.waitFor();
  expect(await detail.locator("textarea").count()).toBe(0);
  await assertParent();
  await capture(page, "desktop-subagent-transcript", childStop);

  proof.stage = "independent process list and retained output";
  await openChatSidePanelType(page, "Processes");
  const processes = parent.locator("openclaw-chat-processes-panel");
  proof.stage = "wait for process list with retained output";
  const processList = await waitForPayload<SessionsProcessesListResult>(
    "sessions.processes.list",
    (payload, rpc) =>
      paramsOf(rpc).key === fixture.key &&
      payload?.processes?.some((row) => row.tail.includes(fixture.output)) === true,
  );
  expect(processList.processes).toHaveLength(1);
  const processRow = processList.processes[0]!;
  expect(processRow).toMatchObject({ status: "running", canStop: true, truncated: false });
  const processOpen = button(processes, processRow.name);
  await processOpen.click();
  await processes.getByRole("heading", { name: "Recent output", exact: true }).waitFor();
  expect(await processes.locator("pre").textContent()).toContain(fixture.output);
  const processStop = button(processes, "Stop " + processRow.name);
  await capture(page, "desktop-process-output", processStop);
  await assertParent();
  const switchTab = async (label: string) => {
    await parent.locator(".side-panel__header .tabstrip-tab").filter({ hasText: label }).click();
  };
  expect(await parent.locator(".side-panel__header .tabstrip-tab").allTextContents()).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Subagents"),
      expect.stringContaining("Processes"),
    ]),
  );

  proof.stage = "mobile child Stop through history-owned exact run";
  await page.setViewportSize({ width: 390, height: 844 });
  await switchTab("Subagents");
  await childStop.waitFor();
  await capture(page, "mobile-subagent-transcript", childStop);
  const beforeChildStop = wire.completed.length;
  await childStop.click();
  const stoppedChild = await wire.waitFor(
    (rpc) => ["chat.abort", "sessions.abort"].includes(rpc.request.method),
    beforeChildStop,
  );
  recordRpc("childStop", stoppedChild);
  await saveProof();
  const childMethod = run.sessionAbortable ? "sessions.abort" : "chat.abort";
  expect(stoppedChild.request.method).toBe(childMethod);
  expect(paramsOf(stoppedChild)).toMatchObject({
    [run.sessionAbortable ? "key" : "sessionKey"]: childKey,
    runId: run.runId,
  });
  expect(paramsOf(stoppedChild).clearQueued).toBeUndefined();
  const childReply = payloadOf<Record<string, unknown>>(stoppedChild);
  expect(childReply).toMatchObject(
    run.sessionAbortable
      ? { ok: true, status: "aborted", abortedRunId: run.runId }
      : { ok: true, aborted: true, runIds: expect.arrayContaining([run.runId]) },
  );
  proof.stage = "settle child provider cancellation";
  await provider.wait(provider.childClosed, signal);
  await childStop.waitFor({ state: "hidden" });
  expect(provider.processIsOpen(), "child Stop must not stop parent exec").toBe(true);
  await assertParent();
  proof.childStop = {
    method: childMethod,
    params: paramsOf(stoppedChild),
    response: childReply,
    providerConnectionClosed: true,
  };
  await button(detail, "Back to Subagents").click();
  await button(subagents.locator(".chat-subagents__finished"), fixture.childLabel).waitFor();

  proof.stage = "mobile exact process Stop and retained terminal output";
  await switchTab("Processes");
  await processStop.waitFor();
  await capture(page, "mobile-process-output", processStop);
  const beforeProcessStop = wire.completed.length;
  await processStop.click();
  const stoppedProcess = await wire.waitFor(
    (rpc) => rpc.request.method === "sessions.processes.stop",
    beforeProcessStop,
  );
  recordRpc("processStop", stoppedProcess);
  await saveProof();
  expect(paramsOf(stoppedProcess)).toMatchObject({
    key: fixture.key,
    sessionId: processList.sessionId,
    processId: processRow.processId,
    instanceId: processRow.instanceId,
  });
  expect(payloadOf<SessionsProcessesStopResult>(stoppedProcess)).toEqual({
    requested: true,
  });
  proof.stage = "settle process cancellation and observe terminal response";
  await provider.wait(provider.processClosed, signal);
  const terminalList = await waitForPayload<SessionsProcessesListResult>(
    "sessions.processes.list",
    (payload, rpc) =>
      paramsOf(rpc).key === fixture.key &&
      payload?.processes?.some(
        (row) => row.instanceId === processRow.instanceId && row.status !== "running",
      ) === true,
    beforeProcessStop,
  );
  const terminal = terminalList.processes.find((row) => row.instanceId === processRow.instanceId)!;
  expect(terminal).toMatchObject({
    processId: processRow.processId,
    status: "killed",
    canStop: false,
    endedAt: expect.any(Number),
    tail: expect.stringContaining(fixture.output),
  });
  await processes.getByText("Stopped", { exact: true }).waitFor();
  await processStop.waitFor({ state: "hidden" });
  await button(processes, "Back to Processes").click();
  const finishedToggle = button(processes, "Finished (1)");
  const reopenFinished = async (screenshot: string, waitForRow = false) => {
    await finishedToggle.waitFor();
    expect(await finishedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(await processOpen.count()).toBe(0);
    await finishedToggle.click();
    if (waitForRow) {
      await processOpen.waitFor();
    }
    await processOpen.click();
    expect(await processes.locator("pre").textContent()).toContain(fixture.output);
    await capture(page, screenshot, button(processes, "Back to Processes"));
  };
  await reopenFinished("mobile-process-stopped-output");
  await assertParent();
  proof.processStop = {
    params: paramsOf(stoppedProcess),
    response: payloadOf(stoppedProcess),
    socketClosed: true,
    terminal,
  };

  proof.stage = "reload parent with independent panels and durable draft";
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await waitForControlUiGatewayReady(page);
  await composer.waitFor();
  await assertParent();
  await reopenFinished("desktop-reloaded-process-output", true);
  await switchTab("Subagents");
  await childOpen.click();
  await detail.getByText(fixture.childText, { exact: true }).waitFor();
  await assertParent();
  proof.draftPreservedAfterReload = true;
  expect(wire.completed.filter((rpc) => rpc.request.method === "chat.send")).toHaveLength(1);
  proof.stage = "complete";
  proof.complete = true;
  await saveProof();
  signal.removeEventListener("abort", logFailure);
}

suite.define(() => {
  it(
    "inspects and stops exact child/process work independently while preserving the parent draft",
    (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: runBackgroundWork,
      }),
    120_000,
  );
});
