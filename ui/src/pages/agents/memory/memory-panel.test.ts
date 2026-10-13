/* @vitest-environment jsdom */

import { createComponent, flush } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import { ShellLayoutOwner } from "../../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../../app/shell-layout-traits-solid.tsx";
import {
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "../../../components/confirm-dialog.ts";
import { i18n } from "../../../i18n/index.ts";
import type { TranslationMap } from "../../../i18n/lib/types.ts";
import { en } from "../../../i18n/locales/en.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import type { DreamDiaryActionMethod, DreamingState, WikiOverview } from "./dreaming.ts";
import { AgentMemoryState } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";
import { AgentMemoryPanel } from "./memory-panel.tsx";
import type { DreamingViewState } from "./view.tsx";

vi.mock("../../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

type TestMemoryPanel = {
  connect: () => void;
  disconnect: () => void;
  context: ApplicationContext;
  agentId: string;
  dreaming: DreamingState;
  viewState: DreamingViewState;
  toggleConfirmLoading: boolean;
  pendingEnabled: boolean | null;
  applyAgentId: () => void;
  applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
  loadResources: () => Promise<void>;
  openWikiPage: (lookup: string) => Promise<unknown>;
  confirmDreamingTask: (
    method: DreamDiaryActionMethod,
    confirmation: ConfirmDialogOptions,
  ) => Promise<void>;
  requestUpdate: () => void;
  readonly updateComplete: Promise<boolean>;
};

let restoreTranslations = () => {};

beforeAll(() => {
  const dreaming =
    en.dreaming && typeof en.dreaming === "object" ? (en.dreaming as TranslationMap) : {};
  const wiki =
    dreaming.wiki && typeof dreaming.wiki === "object" ? (dreaming.wiki as TranslationMap) : {};
  i18n.registerTranslation("en", {
    ...en,
    dreaming: {
      ...dreaming,
      wiki: {
        ...wiki,
        noContent: "No wiki content available.",
      },
    },
  });
  restoreTranslations = () => i18n.registerTranslation("en", en);
});

afterAll(() => {
  restoreTranslations();
});

function contextWithGateway(
  client: GatewayBrowserClient,
  connected: boolean,
  configForm: Record<string, unknown> | null = null,
): ApplicationContext {
  const snapshot: ApplicationGatewaySnapshot = {
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
  const subscribe = () => () => undefined;
  return {
    gateway: { snapshot, subscribe },
    agents: {
      state: { agentsList: null },
      subscribe,
    },
    runtimeConfig: {
      state: { configForm, configSnapshot: null },
      ensureLoaded: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      removeFormValue: vi.fn(),
      waitForPendingWrites: vi.fn(async () => undefined),
      save: vi.fn(async () => true),
      patch: vi.fn(async () => true),
      subscribe,
    },
  } as unknown as ApplicationContext;
}

const states = new Set<AgentMemoryState>();
function createMemoryState(): TestMemoryPanel {
  const state = new AgentMemoryState();
  states.add(state);
  return state as unknown as TestMemoryPanel;
}

function createPage(context: ApplicationContext): TestMemoryPanel {
  const page = createMemoryState();
  page.context = context;
  page.agentId = "main";
  page.loadResources = vi.fn(async () => undefined);
  return page;
}

async function replaceContext(page: TestMemoryPanel, context: ApplicationContext) {
  page.context = context;
  page.requestUpdate();
  await page.updateComplete;
}

afterEach(() => {
  cleanupSolid();
  for (const state of states) {
    state.disconnect();
  }
  states.clear();
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("AgentMemoryPanel gateway lifecycle", () => {
  it.each(["lit", "solid"] as const)(
    "registers the memory host and releases shell layout for %s callers",
    async (renderer) => {
      const context = contextWithGateway({} as GatewayBrowserClient, false);
      const content = document.createElement("main");
      content.className = "content";
      document.body.append(content);
      const owner = new ShellLayoutOwner();
      owner.contentRef(content);
      if (renderer === "lit") {
        const provider = createApplicationContextProvider(context);
        const host = document.createElement("openclaw-agent-memory-panel");
        host.agentId = "support";
        provider.append(host);
        content.append(provider);
      } else {
        const provider = createSolidApplicationContextProvider(context);
        mountSolid(
          () =>
            createComponent(ShellLayoutProvider, {
              value: { owner, host: content },
              get children() {
                return createComponent(AgentMemoryPanel, { agentId: "support" });
              },
            }),
          { container: content, wrapper: provider.wrapper },
        );
      }
      const host = content.querySelector("openclaw-agent-memory-panel")!;
      await host.updateComplete;
      flush();
      expect(host.agentId).toBe("support");
      expect(host.querySelector(".agent-memory-panel__header")).not.toBeNull();
      expect(owner.current.toolbarHeader).toBe(true);
      if (renderer === "solid") {
        cleanupSolid();
      } else {
        host.remove();
      }
      await Promise.resolve();
      expect(owner.current.toolbarHeader).toBeUndefined();
    },
  );

  it("waits for a committed agent before loading agent-scoped memory", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      if (method === "doctor.memory.dreamDiary") {
        return { found: false, path: "DREAMS.md" };
      }
      return {};
    });
    const page = createMemoryState();
    page.context = contextWithGateway({ request } as unknown as GatewayBrowserClient, true);

    page.connect();
    await page.updateComplete;
    await page.updateComplete;
    await Promise.resolve();
    await expect(page.openWikiPage("unowned.md")).resolves.toBeNull();

    expect(request).not.toHaveBeenCalled();

    page.agentId = "support";
    await page.updateComplete;
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "doctor.memory.status")).toEqual([
        ["doctor.memory.status", { agentId: "support" }],
      ]);
      expect(
        request.mock.calls.filter(([method]) => method === "doctor.memory.dreamDiary"),
      ).toEqual([["doctor.memory.dreamDiary", { agentId: "support" }]]);
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  it.each([false, true])(
    "keeps confirmed dreaming actions scoped to their agent (changed: %s)",
    async (changed) => {
      const confirmation = deferred<boolean>();
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
      const method = "doctor.memory.repairDreamingArtifacts";
      const request = vi.fn(async () => ({}));
      const context = contextWithGateway({ request } as unknown as GatewayBrowserClient, true);
      context.gateway.snapshot.hello = gatewayHelloForMethods([method], ["operator.write"]);
      const page = createPage(context);
      page.connect();
      await page.updateComplete;

      const pending = page.confirmDreamingTask(method, { message: "Repair?" });
      if (changed) {
        page.agentId = "support";
        await page.updateComplete;
      }
      confirmation.resolve(true);
      await pending;

      if (changed) {
        expect(request).not.toHaveBeenCalled();
      } else {
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenNthCalledWith(1, method, { agentId: "main" });
        expect(request).toHaveBeenNthCalledWith(2, "doctor.memory.status", { agentId: "main" });
      }
    },
  );

  it("resets stale panel data when the selected agent changes", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.connect();
    await page.updateComplete;
    const previousState = page.dreaming;
    previousState.dreamDiaryContent = "main-only";

    page.agentId = "support";
    await page.updateComplete;

    expect(page.dreaming).not.toBe(previousState);
    expect(page.dreaming.selectedAgentId).toBe("support");
    expect(page.dreaming.dreamDiaryContent).toBeNull();

    page.dreaming.dreamDiaryContent = "support-only";
    page.agentId = "";
    await page.updateComplete;

    expect(page.dreaming.selectedAgentId).toBeNull();
    expect(page.dreaming.dreamDiaryContent).toBeNull();
  });

  it("resets provider and modal state when the gateway source changes", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, false));
    page.connect();
    await page.updateComplete;
    const previousState = page.dreaming;
    previousState.dreamDiaryContent = "old provider";
    const wikiPreview = {
      loading: true,
      error: null,
      page: { title: "Old page", path: "old.md", content: "old wiki" },
    };
    page.viewState.wikiPreview = wikiPreview;
    page.toggleConfirmLoading = true;
    page.pendingEnabled = true;

    await replaceContext(page, contextWithGateway(client, false));

    expect(page.dreaming).not.toBe(previousState);
    expect(page.dreaming.dreamDiaryContent).toBeNull();
    expect(page.viewState.wikiPreview).toBeNull();
    expect(page.toggleConfirmLoading).toBe(false);
    expect(page.pendingEnabled).toBeNull();

    page.viewState.wikiPreview = wikiPreview;
    page.toggleConfirmLoading = true;
    page.pendingEnabled = false;
    page.disconnect();

    expect(page.viewState.wikiPreview).toBeNull();
    expect(page.toggleConfirmLoading).toBe(false);
    expect(page.pendingEnabled).toBeNull();
  });

  it.each([false, true])(
    "discards a wiki response from a replaced gateway source (subscription rebound: %s)",
    async (rebound) => {
      const pending = deferred<unknown>();
      const client = {
        request: vi.fn(() => pending.promise),
      } as unknown as GatewayBrowserClient;
      const page = createPage(contextWithGateway(client, true));
      page.connect();
      await page.updateComplete;

      const preview = page.openWikiPage("old.md");
      const nextContext = contextWithGateway(client, false);
      if (rebound) {
        await replaceContext(page, nextContext);
      } else {
        page.context = nextContext;
      }
      pending.resolve({ title: "Old", path: "old.md", content: "stale" });

      await expect(preview).resolves.toBeNull();
    },
  );

  it("discards a wiki response across a same-client reconnect", async () => {
    const pending = deferred<unknown>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.connect();
    await page.updateComplete;

    const previousState = page.dreaming;
    const preview = page.openWikiPage("old.md");
    page.applyGatewaySnapshot({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
    page.applyGatewaySnapshot({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    pending.resolve({ title: "Old", path: "old.md", content: "stale" });

    await expect(preview).resolves.toBeNull();
    expect(page.dreaming).not.toBe(previousState);
    expect(page.viewState.wikiPreview).toBeNull();
  });

  it("loads wiki previews for the selected agent", async () => {
    const request = vi.fn(async () => ({
      title: "Support",
      path: "support.md",
      content: "support-only",
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.agentId = "support";
    page.connect();
    await page.updateComplete;

    await page.openWikiPage("support.md");

    expect(request).toHaveBeenCalledWith("wiki.get", {
      lookup: "support.md",
      fromLine: 1,
      lineCount: 5000,
      agentId: "support",
    });
  });

  it("updates the mounted view across tab selection and owner notifications", async () => {
    const page = createPage(contextWithGateway({} as GatewayBrowserClient, true));
    page.connect();
    await page.updateComplete;
    const container = document.createElement("div");
    document.body.append(container);
    mountSolid(() => AgentMemoryView({ state: page as unknown as AgentMemoryState }), {
      container,
    });
    flush();
    const scene = container.querySelector(".dreams");
    page.dreaming.dreamingStatus = {
      enabled: true,
      promotedToday: 9,
      phases: {
        light: { enabled: true },
        deep: { enabled: false },
        rem: { enabled: false },
      },
    } as DreamingState["dreamingStatus"];
    page.requestUpdate();
    await page.updateComplete;
    flush();
    expect(container.querySelector(".dreams")).toBe(scene);
    expect(container.querySelector(".dreams__status-detail")?.textContent).toContain("9 promoted");
    expect(container.querySelectorAll(".dreams__phase--off")).toHaveLength(2);

    page.dreaming.dreamDiaryContent =
      "*April 4, 2026*\nFirst dream.\n---\n*April 5, 2026*\nSecond dream.";
    container
      .querySelector("#dreams-tab-diary")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await page.updateComplete;
    flush();
    expect(container.querySelector(".dreams-diary")).not.toBeNull();
    const dayChip = container.querySelectorAll<HTMLButtonElement>(".dreams-diary__day-chip")[1]!;
    dayChip.focus();
    dayChip.click();
    await page.updateComplete;
    flush();
    expect(container.querySelectorAll(".dreams-diary__day-chip")[1]).toBe(dayChip);
    expect(document.activeElement).toBe(dayChip);
    expect(dayChip.classList.contains("dreams-diary__day-chip--active")).toBe(true);
    page.requestUpdate();
    await page.updateComplete;
    flush();
    expect(container.querySelectorAll(".dreams-diary__day-chip")[1]).toBe(dayChip);
    expect(document.activeElement).toBe(dayChip);
    container
      .querySelector("#dream-diary-tab-insights")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await page.updateComplete;
    flush();
    expect(container.querySelector("#dream-diary-panel")?.textContent).toContain("memory-wiki");
    expect(container.querySelector("#dream-diary-panel")?.getAttribute("aria-labelledby")).toBe(
      "dream-diary-tab-insights",
    );
    const preview = {
      loading: true,
      error: null,
      page: { title: "Example", path: "example.md", content: "" },
    };
    page.viewState.wikiPreview = preview;
    page.requestUpdate();
    await page.updateComplete;
    flush();
    const dialog = container.querySelector("openclaw-modal-dialog");
    expect(dialog).not.toBeNull();
    preview.loading = false;
    preview.page.content = "Loaded wiki page";
    page.requestUpdate();
    await page.updateComplete;
    flush();
    expect(container.querySelector("openclaw-modal-dialog")).toBe(dialog);
    expect(container.querySelector(".dreams-diary__preview-pre")?.textContent).toBe(
      "Loaded wiki page",
    );
    page.context.runtimeConfig.state.configSnapshot = {
      config: { plugins: { entries: { "memory-wiki": { enabled: true } } } },
    };
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
    const wikiCluster: WikiOverview["clusters"][number] = {
      key: "synthesis",
      label: "Syntheses",
      itemCount: 1,
      claimCount: 1,
      questionCount: 0,
      contradictionCount: 0,
      items: [wikiPage],
    };
    page.dreaming.wikiOverview = {
      totalItems: 1,
      totalPages: 1,
      truncated: false,
      pageCounts: { synthesis: 1, entity: 0, concept: 0, source: 0, report: 0 },
      totalClaims: 1,
      totalQuestions: 0,
      totalContradictions: 0,
      clusters: [wikiCluster],
    };
    container
      .querySelector("#dream-diary-tab-wiki")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await page.updateComplete;
    flush();
    const card = container.querySelector("[data-wiki-page]")!;
    const details = card.querySelector<HTMLButtonElement>("button")!;
    details.focus();
    details.click();
    await page.updateComplete;
    flush();
    expect(container.querySelector("[data-wiki-page]")).toBe(card);
    expect(document.activeElement).toBe(details);
    page.dreaming.wikiOverview = {
      ...page.dreaming.wikiOverview!,
      clusters: [{ ...wikiCluster, items: [{ ...wikiPage, title: "Refreshed title" }] }],
    };
    page.requestUpdate();
    await page.updateComplete;
    flush();
    expect(container.querySelector("[data-wiki-page]")).toBe(card);
    expect(card.querySelector("button")).toBe(details);
    expect(document.activeElement).toBe(details);
    expect(card.querySelector(".dreams-diary__insight-title")?.textContent).toBe("Refreshed title");
  });

  it("renders explicit engine Off as unavailable with a latent override", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "none" },
        entries: {
          "memory-core": { config: { dreaming: { enabled: false } } },
        },
      },
    });
    const page = createMemoryState();
    page.context = context;
    page.agentId = "main";
    const container = document.createElement("div");

    mountSolid(() => AgentMemoryView({ state: page as unknown as AgentMemoryState }), {
      container,
    });

    expect(container.textContent).toContain(
      "Memory engine is Off. Choose an engine in Settings to enable dreaming.",
    );
    expect(container.textContent).not.toContain("Using default: Enabled");
    expect(container.querySelector<HTMLButtonElement>(".dreams__phase-toggle")?.disabled).toBe(
      true,
    );
  });

  it("does not present cached runtime status after the memory engine switches Off", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: { slots: { memory: "none" } },
    });
    const page = createMemoryState();
    page.context = context;
    page.agentId = "main";
    page.dreaming.dreamingStatus = {
      enabled: true,
      promotedToday: 7,
      timezone: "Mars/Base",
      phases: {
        light: { enabled: true, cron: "* * * * *", managedCronPresent: true },
        deep: {
          enabled: true,
          cron: "* * * * *",
          managedCronPresent: true,
          limit: 1,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          recencyHalfLifeDays: 1,
        },
        rem: {
          enabled: true,
          cron: "* * * * *",
          managedCronPresent: true,
          lookbackDays: 1,
          limit: 1,
          minPatternStrength: 0,
        },
      },
    } as NonNullable<DreamingState["dreamingStatus"]>;
    const container = document.createElement("div");

    mountSolid(() => AgentMemoryView({ state: page as unknown as AgentMemoryState }), {
      container,
    });

    const toggle = container.querySelector<HTMLButtonElement>(".dreams__phase-toggle");
    expect(toggle?.textContent).toContain("Off");
    expect(toggle?.classList.contains("dreams__phase-toggle--on")).toBe(false);
    expect(container.querySelector(".dreams__status-label")?.textContent).toContain("Idle");
    expect(container.textContent).toContain("0 promoted");
    expect(container.textContent).not.toContain("7 promoted");
    expect(container.textContent).not.toContain("Mars/Base");
    expect(
      [...container.querySelectorAll(".dreams__phase-next")].every(
        (phase) => phase.textContent?.trim() === "—",
      ),
    ).toBe(true);
  });

  it("omits default provenance when engine Off has no latent override", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: { slots: { memory: "none" } },
    });
    const page = createMemoryState();
    page.context = context;
    page.agentId = "main";
    const container = document.createElement("div");

    mountSolid(() => AgentMemoryView({ state: page as unknown as AgentMemoryState }), {
      container,
    });

    expect(container.textContent).not.toContain("Using default: Enabled");
    const toggle = container.querySelector<HTMLButtonElement>(".dreams__phase-toggle");
    expect(toggle?.disabled).toBe(true);
    toggle?.click();
    expect(page.pendingEnabled).toBeNull();
  });

  it("uses localized empty content for wiki previews", async () => {
    const client = {
      request: vi.fn(async () => ({ title: "Empty", path: "empty.md", content: "" })),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.connect();
    await page.updateComplete;

    await expect(page.openWikiPage("empty.md")).resolves.toMatchObject({
      content: "No wiki content available.",
    });
  });

  it("discards a wiki preview after the selected agent changes", async () => {
    const pending = deferred<unknown>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.agentId = "support";
    page.connect();
    await page.updateComplete;

    const preview = page.openWikiPage("support.md");
    page.agentId = "marketing";
    await page.updateComplete;
    pending.resolve({ title: "Support", path: "support.md", content: "stale" });

    await expect(preview).resolves.toBeNull();
  });

  it("closes an open wiki preview when the selected agent changes", async () => {
    const client = {
      request: vi.fn(async () => ({})),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.agentId = "support";
    page.connect();
    await page.updateComplete;
    page.viewState.wikiPreview = {
      loading: true,
      error: null,
      page: { title: "Support", path: "support.md", content: "support-only" },
    };

    page.agentId = "marketing";
    await page.updateComplete;

    expect(page.viewState.wikiPreview).toBeNull();
  });
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
          .locator("wa-dropdown-item[data-agent-option]")
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
