/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createComponent, createSignal, flush } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import { ShellLayoutOwner } from "../../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../../app/shell-layout-traits-solid.tsx";
import { showConfirmDialog } from "../../../components/confirm-dialog.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createAgentMemory, type AgentMemoryState } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";
import { AgentMemoryPanel } from "./memory-panel.tsx";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";

vi.mock("../../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
let restoreTranslations = () => {};
beforeAll(() => {
  restoreTranslations = installDreamingViewTestTranslations();
});
afterAll(() => restoreTranslations());
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

function contextWithGateway(
  client: GatewayBrowserClient,
  connected: boolean,
  configForm: Record<string, unknown> | null = null,
) {
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(["config.patch"]),
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewayListeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const configListeners = new Set<() => void>();
  const context = {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: (value: ApplicationGatewaySnapshot) => void) => {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    },
    agents: { state: { agentsList: null }, subscribe: () => () => {} },
    runtimeConfig: {
      state: { configForm, configSnapshot: null },
      ensureLoaded: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      removeFormValue: vi.fn(),
      waitForPendingWrites: vi.fn(async () => undefined),
      save: vi.fn(async () => true),
      patch: vi.fn(async () => true),
      subscribe: (listener: () => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
    },
  } as unknown as ApplicationContext;
  return Object.assign(context, {
    emit(patch: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of gatewayListeners) {
        listener(snapshot);
      }
    },
    setConfig(config: Record<string, unknown>) {
      context.runtimeConfig.state.configForm = config;
      context.runtimeConfig.state.configSnapshot = { config };
      for (const listener of configListeners) {
        listener();
      }
    },
  });
}

function emptyReply(method: string) {
  return method === "doctor.memory.status"
    ? { dreaming: null }
    : { found: false, path: "DREAMS.md" };
}
async function createPage(context: ApplicationContext, agentId = "main") {
  const container = document.createElement("div");
  document.body.append(container);
  let state: AgentMemoryState;
  const mounted = mountSolid(
    () => {
      state = createAgentMemory(context);
      state.setAgentId(agentId);
      return AgentMemoryView({ state });
    },
    { container },
  );
  await waitForSolid(() => expect(state.view().header.refreshLoading).toBe(false));
  return {
    get state() {
      return state;
    },
    container,
    unmount: mounted.unmount,
  };
}

function click(container: HTMLElement, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
  flush();
}

const wikiPage = {
  pagePath: "syntheses/example.md",
  title: "Original title",
  kind: "synthesis" as const,
  claimCount: 1,
  questionCount: 0,
  contradictionCount: 0,
  claims: ["A supported claim"],
  questions: [],
  contradictions: [],
};
function wikiOverview(title = wikiPage.title) {
  return {
    totalItems: 1,
    totalPages: 1,
    truncated: false,
    pageCounts: { synthesis: 1, entity: 0, concept: 0, source: 0, report: 0 },
    totalClaims: 1,
    totalQuestions: 0,
    totalContradictions: 0,
    clusters: [
      {
        key: "synthesis",
        label: "Syntheses",
        itemCount: 1,
        claimCount: 1,
        questionCount: 0,
        contradictionCount: 0,
        items: [{ ...wikiPage, title }],
      },
    ],
  };
}

describe("AgentMemoryPanel gateway lifecycle", () => {
  it("scopes native memory requests to the current agent and releases shell layout", async () => {
    const request = vi.fn(async (method: string) =>
      method === "doctor.memory.status" ? { dreaming: null } : { found: false, path: "DREAMS.md" },
    );
    const context = contextWithGateway(createTestGatewayClient(request), true);
    const unsubscribe = vi.fn();
    context.gateway.subscribe = () => unsubscribe;
    const content = document.createElement("main");
    content.className = "content";
    document.body.append(content);
    const owner = new ShellLayoutOwner();
    owner.contentRef(content);
    const provider = createSolidApplicationContextProvider(context);
    const [agentId, setAgentId] = createSignal("support");
    const view = mountSolid(
      () =>
        createComponent(ShellLayoutProvider, {
          value: { owner, host: content },
          get children() {
            return createComponent(AgentMemoryPanel, {
              get agentId() {
                return agentId();
              },
            });
          },
        }),
      { container: content, wrapper: provider.wrapper },
    );
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "support" }),
    );
    const host = content.querySelector("openclaw-agent-memory-panel")!;
    expect(host.querySelector(".agent-memory-panel__header")).not.toBeNull();
    expect(owner.current.toolbarHeader).toBe(true);

    setAgentId("main");
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "main" }),
    );
    expect(content.querySelector("openclaw-agent-memory-panel")).toBe(host);
    view.unmount();
    expect(owner.current.toolbarHeader).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("waits for a committed agent before loading agent-scoped memory", async () => {
    const request = vi.fn(async (method: string) => emptyReply(method));
    const page = await createPage(contextWithGateway(createTestGatewayClient(request), true), "");
    await page.state.view().dreaming.onOpenWikiPage("unowned.md");
    expect(request).not.toHaveBeenCalled();
    page.state.setAgentId("support");
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "support" });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "support" });
  });

  it.each([false, true])(
    "keeps confirmed dreaming actions scoped to their agent (changed: %s)",
    async (changed) => {
      const confirmation = deferred<boolean>();
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
      const method = "doctor.memory.repairDreamingArtifacts";
      const request = vi.fn(async (name: string) => emptyReply(name));
      const context = contextWithGateway(createTestGatewayClient(request), true);
      context.emit({ hello: gatewayHelloForMethods([method], ["operator.write"]) });
      const page = await createPage(context);
      page.state.view().dreaming.onRepairDreamingArtifacts();
      expect(showConfirmDialog).toHaveBeenCalledOnce();
      if (changed) {
        page.state.setAgentId("support");
      }
      confirmation.resolve(true);
      await waitForSolid(() =>
        expect(page.state.view().dreaming.dreamDiaryActionLoading).toBe(false),
      );
      if (changed) {
        expect(request.mock.calls.some(([name]) => name === method)).toBe(false);
      } else {
        await waitForSolid(() => expect(request).toHaveBeenCalledWith(method, { agentId: "main" }));
      }
    },
  );

  it("resets stale panel data when the selected agent changes", async () => {
    const reply = deferred<unknown>();
    const request = vi.fn((method: string, params?: unknown) =>
      method === "doctor.memory.dreamDiary"
        ? asOptionalRecord(params)?.agentId === "main"
          ? Promise.resolve({ found: true, path: "DREAMS.md", content: "main-only" })
          : reply.promise
        : Promise.resolve(emptyReply(method)),
    );
    const page = await createPage(contextWithGateway(createTestGatewayClient(request), true));
    await waitForSolid(() =>
      expect(page.state.view().dreaming.dreamDiaryContent).toBe("main-only"),
    );
    page.state.setAgentId("support");
    expect(page.state.view().dreaming.selectedAgentId).toBe("support");
    expect(page.state.view().dreaming.dreamDiaryContent).toBeNull();
    page.state.setAgentId("");
    reply.resolve({ found: true, path: "DREAMS.md", content: "support-only" });
    await waitForSolid(() => expect(page.state.view().dreaming.selectedAgentId).toBe(""));
    expect(page.state.view().dreaming.dreamDiaryContent).toBeNull();
  });

  it.each(["agent", "client", "reconnect", "unmount"] as const)(
    "retires pending wiki requests and modal state on %s replacement",
    async (replacement) => {
      const pending = deferred<unknown>();
      const request = vi.fn((method: string) =>
        method === "wiki.get" ? pending.promise : Promise.resolve(emptyReply(method)),
      );
      const client = createTestGatewayClient(request);
      const context = contextWithGateway(client, true);
      const page = await createPage(context, "support");
      click(page.container, "#dreams-tab-diary");
      const preview = page.state.view().dreaming.onOpenWikiPage("support.md");
      page.state.setEnabled(false);
      await waitForSolid(() =>
        expect(page.container.querySelector(".dreams-diary__preview-panel")).not.toBeNull(),
      );
      expect(page.state.view().toggle.open).toBe(true);
      if (replacement === "agent") {
        page.state.setAgentId("marketing");
      } else if (replacement === "client") {
        context.emit({
          client: createTestGatewayClient(vi.fn(async (method) => emptyReply(method))),
        });
      } else if (replacement === "reconnect") {
        context.emit({ phase: "stopped" });
        context.emit({ phase: "connected" });
      } else {
        page.unmount();
      }
      pending.resolve({ title: "Support", path: "support.md", content: "stale" });
      await preview;
      flush();
      expect(page.container.querySelector(".dreams-diary__preview-panel")).toBeNull();
      expect(page.container.querySelector("openclaw-modal-dialog")).toBeNull();
      if (replacement !== "unmount") {
        expect(page.state.view().toggle.open).toBe(false);
        expect(page.state.view().dreaming.wikiPreview).toBeNull();
      }
    },
  );

  it("loads wiki previews for the selected agent and keeps the dialog while content arrives", async () => {
    const response = deferred<unknown>();
    const request = vi.fn((method: string) =>
      method === "wiki.get" ? response.promise : Promise.resolve(emptyReply(method)),
    );
    const page = await createPage(
      contextWithGateway(createTestGatewayClient(request), true),
      "support",
    );
    click(page.container, "#dreams-tab-diary");
    const pending = page.state.view().dreaming.onOpenWikiPage("support.md");
    flush();
    const dialog = page.container.querySelector("openclaw-modal-dialog");
    expect(dialog).not.toBeNull();
    expect(request).toHaveBeenCalledWith("wiki.get", {
      lookup: "support.md",
      fromLine: 1,
      lineCount: 5000,
      agentId: "support",
    });
    response.resolve({
      title: "Support",
      path: "support.md",
      content: "support-only",
      totalLines: 6001,
      truncated: true,
    });
    await pending;
    await waitForSolid(() =>
      expect(page.container.querySelector(".dreams-diary__preview-pre")?.textContent).toBe(
        "support-only",
      ),
    );
    expect(page.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
    expect(page.container.querySelector(".dreams-diary__preview-hint")?.textContent).toContain(
      "6001",
    );
    click(page.container, ".dreams-diary__preview-footer button");
    expect(page.state.view().dreaming.wikiPreview).toBeNull();
  });

  it("uses localized empty content for wiki previews", async () => {
    const request = vi.fn(async (method: string) =>
      method === "wiki.get"
        ? { title: "Empty", path: "empty.md", content: "" }
        : emptyReply(method),
    );
    const page = await createPage(contextWithGateway(createTestGatewayClient(request), true));
    await page.state.view().dreaming.onOpenWikiPage("empty.md");
    expect(page.state.view().dreaming.wikiPreview?.page.content).toBe("No wiki content available.");
  });

  it("updates the mounted view across tab selection and owner notifications", async () => {
    let promotedToday = 2;
    let title = wikiPage.title;
    const request = vi.fn(async (method: string) =>
      method === "doctor.memory.status"
        ? {
            dreaming: {
              enabled: true,
              promotedToday,
              phases: {
                light: { enabled: true },
                deep: { enabled: false },
                rem: { enabled: false },
              },
            },
          }
        : method === "doctor.memory.dreamDiary"
          ? {
              found: true,
              path: "DREAMS.md",
              content: "*April 4, 2026*\nFirst dream.\n---\n*April 5, 2026*\nSecond dream.",
            }
          : method === "wiki.overview"
            ? wikiOverview(title)
            : { clusters: [], totalItems: 0 },
    );
    const context = contextWithGateway(createTestGatewayClient(request), true);
    const page = await createPage(context);
    const scene = page.container.querySelector(".dreams");
    promotedToday = 9;
    await page.state.loadResources();
    await waitForSolid(() =>
      expect(page.container.querySelector(".dreams__status-detail")?.textContent).toContain(
        "9 promoted",
      ),
    );
    expect(page.container.querySelector(".dreams")).toBe(scene);
    expect(page.container.querySelectorAll(".dreams__phase--off")).toHaveLength(2);
    click(page.container, "#dreams-tab-diary");
    const dayChip =
      page.container.querySelectorAll<HTMLButtonElement>(".dreams-diary__day-chip")[1]!;
    dayChip.focus();
    dayChip.click();
    flush();
    await page.state.loadResources();
    flush();
    expect(page.container.querySelectorAll(".dreams-diary__day-chip")[1]).toBe(dayChip);
    expect(document.activeElement).toBe(dayChip);
    expect(dayChip.classList.contains("dreams-diary__day-chip--active")).toBe(true);
    click(page.container, "#dream-diary-tab-insights");
    expect(page.container.querySelector("#dream-diary-panel")?.textContent).toContain(
      "memory-wiki",
    );
    expect(
      page.container.querySelector("#dream-diary-panel")?.getAttribute("aria-labelledby"),
    ).toBe("dream-diary-tab-insights");
    context.setConfig({ plugins: { entries: { "memory-wiki": { enabled: true } } } });
    context.emit({
      hello: gatewayHelloForMethods(["config.patch", "wiki.overview", "wiki.importInsights"]),
    });
    await page.state.loadResources("wikiOverview");
    click(page.container, "#dream-diary-tab-wiki");
    const card = page.container.querySelector("[data-wiki-page]")!;
    const details = card.querySelector<HTMLButtonElement>("button")!;
    details.focus();
    details.click();
    flush();
    title = "Refreshed title";
    await page.state.loadResources("wikiOverview");
    await waitForSolid(() =>
      expect(card.querySelector(".dreams-diary__insight-title")?.textContent).toBe(title),
    );
    expect(page.container.querySelector("[data-wiki-page]")).toBe(card);
    expect(card.querySelector("button")).toBe(details);
    expect(document.activeElement).toBe(details);
  });

  it.each([false, true])(
    "renders engine Off without presenting a cached runtime payload (latent override: %s)",
    async (override) => {
      const request = vi.fn(async (method: string) =>
        method === "doctor.memory.status"
          ? {
              dreaming: {
                enabled: true,
                promotedToday: 7,
                timezone: "Mars/Base",
                phases: {
                  light: { enabled: true },
                  deep: { enabled: true },
                  rem: { enabled: true },
                },
              },
            }
          : emptyReply(method),
      );
      const context = contextWithGateway(createTestGatewayClient(request), true);
      const page = await createPage(context);
      await waitForSolid(() => expect(page.container.textContent).toContain("7 promoted"));
      context.setConfig({
        plugins: {
          slots: { memory: "none" },
          ...(override
            ? { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } }
            : {}),
        },
      });
      await waitForSolid(() =>
        expect(page.container.textContent).toContain("Memory engine is Off"),
      );
      const toggle = page.container.querySelector<HTMLButtonElement>(".dreams__phase-toggle")!;
      expect(toggle.disabled).toBe(true);
      expect(toggle.classList.contains("dreams__phase-toggle--on")).toBe(false);
      expect(page.container.textContent).not.toContain("Using default: Enabled");
      expect(page.container.textContent).toContain("0 promoted");
      expect(page.container.textContent).not.toContain("7 promoted");
      expect(page.container.textContent).not.toContain("Mars/Base");
      toggle.click();
      expect(page.state.view().toggle.open).toBe(false);
    },
  );
});
describe.runIf(process.env.OPENCLAW_UI_MEMORY_CHROMIUM_E2E === "1")(
  "agent memory real Chromium owner proof",
  () => {
    let browser: import("playwright").Browser;
    let server: import("../../../test-helpers/control-ui-e2e.ts").ControlUiE2eServer;
    let e2e: typeof import("../../../test-helpers/control-ui-e2e.ts");

    beforeAll(async () => {
      const { chromium } = await import("playwright");
      e2e = await import("../../../test-helpers/control-ui-e2e.ts");
      const executablePath = e2e.resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
      if (!e2e.canRunPlaywrightChromium(executablePath)) {
        throw new Error(`Real Chromium required but unavailable: ${executablePath}`);
      }
      server = await e2e.startControlUiE2eServer();
      browser = await chromium.launch({ executablePath, headless: true });
    }, 90_000);

    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    it("preserves both routes, agent ownership, wiki gating, and reconnects", async () => {
      const status = (agentId: string, promotedToday: number) => ({
        agentId,
        provider: "builtin",
        embedding: { ok: true, checked: true },
        dreaming: {
          enabled: true,
          verboseLogging: false,
          storageMode: "inline" as const,
          separateReports: false,
          shortTermCount: promotedToday,
          recallSignalCount: 0,
          dailySignalCount: 0,
          groundedSignalCount: 0,
          totalSignalCount: 0,
          phaseSignalCount: 0,
          lightPhaseHitCount: 0,
          remPhaseHitCount: 0,
          promotedTotal: promotedToday,
          promotedToday,
          shortTermEntries: [],
          signalEntries: [],
          promotedEntries: [],
          phases: {
            light: {
              enabled: true,
              cron: "0 * * * *",
              managedCronPresent: true,
              lookbackDays: 2,
              limit: 10,
            },
            deep: {
              enabled: true,
              cron: "0 3 * * *",
              managedCronPresent: true,
              limit: 10,
              minScore: 0.8,
              minRecallCount: 2,
              minUniqueQueries: 2,
              recencyHalfLifeDays: 14,
            },
            rem: {
              enabled: false,
              cron: "0 5 * * 0",
              managedCronPresent: false,
              lookbackDays: 7,
              limit: 10,
              minPatternStrength: 0.75,
            },
          },
        },
      });
      const diary = (agentId: string) => ({
        agentId,
        found: true,
        path: "DREAMS.md",
        content: `# Dream Diary\n\n*April 5, 2026, 3:00 AM*\n\n${agentId} owns this dream.`,
      });
      const config = {
        agents: { entries: { main: {}, support: {} } },
        plugins: {
          entries: {
            "memory-core": { enabled: true, config: { dreaming: { enabled: true } } },
          },
        },
      };
      const roster = {
        agents: [
          { id: "main", name: "Main" },
          { id: "support", name: "Support" },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      };
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const gateway = await e2e.installMockGateway(page, {
        webSocketPassthroughPrefixes: [`${e2e.controlUiBundledGatewayUrl(server.baseUrl)}/?token=`],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "doctor.memory.status",
          "doctor.memory.dreamDiary",
        ],
        methodResponses: {
          "agents.list": roster,
          "config.get": {
            config,
            sourceConfig: config,
            runtimeConfig: config,
            hash: "memory-proof-1",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "plugins.list": {
            plugins: [
              {
                id: "memory-core",
                name: "OpenClaw Memory",
                installed: true,
                enabled: true,
                state: "enabled",
                kind: ["memory"],
              },
            ],
            diagnostics: [],
            mutationAllowed: true,
          },
          "doctor.memory.status": {
            cases: [
              { match: { agentId: "main" }, response: status("main", 11) },
              { match: { agentId: "support" }, response: status("support", 22) },
            ],
          },
          "doctor.memory.dreamDiary": {
            cases: [
              { match: { agentId: "main" }, response: diary("main") },
              { match: { agentId: "support" }, response: diary("support") },
            ],
          },
        },
      });
      const detail = () => page.locator("openclaw-agent-memory-panel .dreams__status-detail");
      const requestCount = () =>
        gateway.getRequests("doctor.memory.status").then((requests) => requests.length);
      const chooseAgent = async (name: string) => {
        const picker = page.locator(".settings-sidebar openclaw-agent-select");
        await picker.locator(".agent-select__trigger").click();
        await picker
          .locator(".agent-select__option[data-agent-option]")
          .filter({ hasText: name })
          .evaluate((item) => (item as HTMLElement).click());
      };

      try {
        expect((await page.goto(`${server.baseUrl}settings/agents/main/memory`))?.status()).toBe(
          200,
        );
        await e2e.waitForControlUiRoute(page, {
          routeId: "agents",
          pathname: "/settings/agents/main/memory",
        });
        await expect
          .poll(async () => await detail().textContent(), { timeout: 15_000 })
          .toContain("11 promoted");
        expect(await gateway.getRequests("wiki.importInsights")).toHaveLength(0);
        expect(await gateway.getRequests("wiki.overview")).toHaveLength(0);

        const beforeFirstMain = await requestCount();
        await gateway.deferNext("doctor.memory.status");
        await page.evaluate(() => {
          history.pushState(null, "", "/settings/memory/dreams");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await e2e.waitForControlUiRoute(page, {
          routeId: "memory",
          pathname: "/settings/memory/dreams",
        });
        await expect.poll(requestCount, { timeout: 15_000 }).toBeGreaterThan(beforeFirstMain);

        const beforeSupport = await requestCount();
        await gateway.deferNext("doctor.memory.status");
        await chooseAgent("Support");
        await expect.poll(requestCount, { timeout: 15_000 }).toBeGreaterThan(beforeSupport);
        await gateway.setMethodResponse("doctor.memory.status", {
          cases: [
            { match: { agentId: "main" }, response: status("main", 33) },
            { match: { agentId: "support" }, response: status("support", 22) },
          ],
        });
        await chooseAgent("Main");
        await expect
          .poll(async () => await detail().textContent(), { timeout: 15_000 })
          .toContain("33 promoted");
        await gateway.resolveDeferred("doctor.memory.status", status("main", 11));
        await gateway.resolveDeferred("doctor.memory.status", status("support", 22));
        await expect
          .poll(async () => await detail().textContent(), { timeout: 15_000 })
          .toContain("33 promoted");
        expect(await gateway.getRequests("wiki.importInsights")).toHaveLength(0);
        expect(await gateway.getRequests("wiki.overview")).toHaveLength(0);

        await gateway.setMethodResponse("doctor.memory.status", status("main", 44));
        const beforeReconnect = await requestCount();
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1001, "proxy idle timeout");
        await gateway.setOnline(false);
        await expect
          .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase), {
            timeout: 15_000,
          })
          .toBe("reconnecting");
        await expect
          .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
          .toBeGreaterThan(socketCount);
        await gateway.setOnline(true);
        await expect.poll(requestCount, { timeout: 15_000 }).toBeGreaterThan(beforeReconnect);
        await expect
          .poll(async () => await detail().textContent(), { timeout: 15_000 })
          .toContain("44 promoted");
        await e2e.waitForControlUiRoute(page, {
          routeId: "memory",
          pathname: "/settings/memory/dreams",
        });
      } finally {
        await context.close();
      }
    }, 120_000);
  },
);
