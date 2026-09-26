/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import {
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "../../../components/confirm-dialog.ts";
import { i18n } from "../../../i18n/index.ts";
import type { TranslationMap } from "../../../i18n/lib/types.ts";
import { en } from "../../../i18n/locales/en.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import type { DreamingState } from "./dreaming.ts";
import type { DreamingViewState } from "./view.ts";
import "./memory-panel.ts";

vi.mock("../../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

type TestMemoryPanel = HTMLElement & {
  context: ApplicationContext;
  agentId: string;
  dreaming: DreamingState;
  viewState: DreamingViewState;
  toggleConfirmOpen: boolean;
  toggleConfirmLoading: boolean;
  pendingEnabled: boolean | null;
  confirmToggle: () => Promise<void>;
  applyAgentId: () => void;
  applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
  loadAll: () => Promise<void>;
  openWikiPage: (lookup: string) => Promise<unknown>;
  confirmDreamingTask: (
    task: (state: DreamingState) => Promise<boolean>,
    confirmation: ConfirmDialogOptions,
  ) => Promise<void>;
  render: () => unknown;
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

function createPage(context: ApplicationContext): TestMemoryPanel {
  const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
  page.context = context;
  page.agentId = "main";
  page.render = () => nothing;
  page.loadAll = vi.fn(async () => undefined);
  return page;
}

async function replaceContext(page: TestMemoryPanel, context: ApplicationContext) {
  page.context = context;
  page.requestUpdate();
  await page.updateComplete;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("AgentMemoryPanel gateway lifecycle", () => {
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
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = contextWithGateway({ request } as unknown as GatewayBrowserClient, true);

    document.body.append(page);
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

  it("does not run a confirmed dreaming action after the selected agent changes", async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const page = createPage(contextWithGateway({} as GatewayBrowserClient, true));
    const task = vi.fn(async () => true);
    document.body.append(page);
    await page.updateComplete;

    const pending = page.confirmDreamingTask(task, { message: "Repair?" });
    page.agentId = "support";
    await page.updateComplete;
    confirmation.resolve(true);
    await pending;

    expect(task).not.toHaveBeenCalled();
  });

  it("resets stale panel data when the selected agent changes", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    document.body.append(page);
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
    document.body.append(page);
    await page.updateComplete;
    const previousState = page.dreaming;
    previousState.dreamDiaryContent = "old provider";
    page.viewState.wikiPreviewOpen = true;
    page.viewState.wikiPreviewLoading = true;
    page.viewState.wikiPreviewTitle = "Old page";
    page.viewState.wikiPreviewContent = "old wiki";
    page.toggleConfirmOpen = true;
    page.toggleConfirmLoading = true;
    page.pendingEnabled = true;

    await replaceContext(page, contextWithGateway(client, false));

    expect(page.dreaming).not.toBe(previousState);
    expect(page.dreaming.dreamDiaryContent).toBeNull();
    expect(page.viewState.wikiPreviewOpen).toBe(false);
    expect(page.viewState.wikiPreviewLoading).toBe(false);
    expect(page.viewState.wikiPreviewTitle).toBe("");
    expect(page.viewState.wikiPreviewContent).toBe("");
    expect(page.toggleConfirmOpen).toBe(false);
    expect(page.toggleConfirmLoading).toBe(false);
    expect(page.pendingEnabled).toBeNull();

    page.viewState.wikiPreviewOpen = true;
    page.toggleConfirmOpen = true;
    page.toggleConfirmLoading = true;
    page.pendingEnabled = false;
    page.remove();

    expect(page.viewState.wikiPreviewOpen).toBe(false);
    expect(page.toggleConfirmOpen).toBe(false);
    expect(page.toggleConfirmLoading).toBe(false);
    expect(page.pendingEnabled).toBeNull();
  });

  it.each([false, true])(
    "discards a wiki response from a replaced gateway source (Lit rebound: %s)",
    async (rebound) => {
      const pending = deferred<unknown>();
      const client = {
        request: vi.fn(() => pending.promise),
      } as unknown as GatewayBrowserClient;
      const page = createPage(contextWithGateway(client, true));
      document.body.append(page);
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
    document.body.append(page);
    await page.updateComplete;

    const previousState = page.dreaming;
    const preview = page.openWikiPage("old.md");
    page.applyGatewaySnapshot({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
    page.applyGatewaySnapshot({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    pending.resolve({ title: "Old", path: "old.md", content: "stale" });

    await expect(preview).resolves.toBeNull();
    expect(page.dreaming).not.toBe(previousState);
    expect(page.viewState.wikiPreviewContent).toBe("");
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
    document.body.append(page);
    await page.updateComplete;

    await page.openWikiPage("support.md");

    expect(request).toHaveBeenCalledWith("wiki.get", {
      lookup: "support.md",
      fromLine: 1,
      lineCount: 5000,
      agentId: "support",
    });
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
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    const container = document.createElement("div");

    render(page.render(), container);

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
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
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

    render(page.render(), container);

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

  it("binds the toggle to configuration while a slot owner reports its own dreaming", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
      },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    page.dreaming.dreamingStatus = {
      enabled: false,
      reportedEnabled: true,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    const container = document.createElement("div");

    render(page.render(), container);

    // The switch shows what it writes; the scene shows what actually runs.
    const toggle = container.querySelector<HTMLButtonElement>(".dreams__phase-toggle");
    expect(toggle?.textContent).toContain("Off");
    expect(toggle?.classList.contains("dreams__phase-toggle--on")).toBe(false);
    expect(container.querySelector(".dreams__status-label")?.textContent).toContain("Dreaming");
    // The owner runs its own dreaming, so the host switch is locked and says why.
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.title).toContain("memory-core runs its own dreaming");
    expect(container.querySelector(".dreaming-header-controls")?.textContent).toContain(
      "runs its own dreaming",
    );
  });

  it("closes the confirmation without writing when the owner's report arrives meanwhile", async () => {
    const request = vi.fn(async () => ({}));
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = contextWithGateway({ request } as unknown as GatewayBrowserClient, true, {
      plugins: { slots: { memory: "memory-core" } },
    });
    page.agentId = "main";
    page.pendingEnabled = true;
    page.toggleConfirmOpen = true;
    page.dreaming.dreamingStatus = {
      enabled: false,
      reportedEnabled: true,
    } as NonNullable<DreamingState["dreamingStatus"]>;

    await page.confirmToggle();

    expect(request).not.toHaveBeenCalled();
    expect(page.toggleConfirmLoading).toBe(false);
    expect(page.toggleConfirmOpen).toBe(false);
    expect(page.pendingEnabled).toBeNull();
  });

  it("does not write when the owner's report arrives during the schema lookup", async () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: { slots: { memory: "memory-core" } },
    });
    const page = createPage(context);
    const runtimeConfig = context.runtimeConfig as unknown as {
      state: Record<string, unknown>;
      lookupSchemaPath: ReturnType<typeof vi.fn>;
      patch: ReturnType<typeof vi.fn>;
    };
    runtimeConfig.state.client = {};
    runtimeConfig.state.connected = true;
    runtimeConfig.state.configSnapshot = {
      hash: "hash-1",
      config: { plugins: { slots: { memory: "memory-core" } } },
    };
    // The status refresh lands while the write awaits the schema lookup.
    runtimeConfig.lookupSchemaPath = vi.fn(async () => {
      page.dreaming.dreamingStatus = {
        enabled: false,
        reportedEnabled: true,
      } as NonNullable<DreamingState["dreamingStatus"]>;
      return {};
    });
    document.body.append(page);
    await page.updateComplete;
    page.pendingEnabled = true;
    page.toggleConfirmOpen = true;

    await page.confirmToggle();

    expect(runtimeConfig.lookupSchemaPath).toHaveBeenCalled();
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(page.toggleConfirmLoading).toBe(false);
    // Declined, not failed: the dialog closes without an error.
    expect(page.toggleConfirmOpen).toBe(false);
    expect(page.pendingEnabled).toBeNull();
    expect(page.dreaming.dreamingStatusError).toBeNull();
  });

  function mountWritablePanel(configSnapshotConfig: Record<string, unknown>) {
    const context = contextWithGateway({} as GatewayBrowserClient, true, configSnapshotConfig);
    const page = createPage(context);
    const runtimeConfig = context.runtimeConfig as unknown as {
      state: Record<string, unknown>;
      lookupSchemaPath: ReturnType<typeof vi.fn>;
      patch: ReturnType<typeof vi.fn>;
    };
    runtimeConfig.state.client = {};
    runtimeConfig.state.connected = true;
    runtimeConfig.state.configSnapshot = { hash: "hash-1", config: configSnapshotConfig };
    runtimeConfig.lookupSchemaPath = vi.fn(async () => ({}));
    return { page, runtimeConfig };
  }

  it("clears the failure when a queued patch is declined by the owner lock", async () => {
    const { page, runtimeConfig } = mountWritablePanel({
      plugins: { slots: { memory: "memory-core" } },
    });
    // The report lands while config.patch waits in its queue; the queue then
    // declines the write through canDispatch and returns false.
    runtimeConfig.patch = vi.fn(async ({ canDispatch }: { canDispatch: () => boolean }) => {
      page.dreaming.dreamingStatus = {
        enabled: false,
        reportedEnabled: true,
      } as NonNullable<DreamingState["dreamingStatus"]>;
      return canDispatch();
    });
    document.body.append(page);
    await page.updateComplete;
    page.pendingEnabled = true;
    page.toggleConfirmOpen = true;

    await page.confirmToggle();

    expect(runtimeConfig.patch).toHaveBeenCalledTimes(1);
    expect(page.dreaming.dreamingStatusError).toBeNull();
    expect(page.toggleConfirmOpen).toBe(false);
    expect(page.pendingEnabled).toBeNull();
  });

  it("lets an already running host sweep be turned off beside a reporting owner", async () => {
    const config = {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { config: { dreaming: { enabled: true } } } },
      },
    };
    const { page, runtimeConfig } = mountWritablePanel(config);
    page.dreaming.dreamingStatus = {
      enabled: true,
      reportedEnabled: true,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    document.body.append(page);
    await page.updateComplete;

    page.pendingEnabled = false;
    page.toggleConfirmOpen = true;
    await page.confirmToggle();

    expect(runtimeConfig.patch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runtimeConfig.patch.mock.calls[0]?.[0]?.raw)).toContain(
      '"enabled":false',
    );
  });

  it("offers turning a running host sweep off beside a reporting owner", async () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { config: { dreaming: { enabled: true } } } },
      },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    page.loadAll = vi.fn(async () => undefined);
    document.body.append(page);
    await page.updateComplete;
    page.dreaming.dreamingStatus = {
      enabled: true,
      reportedEnabled: true,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    page.requestUpdate();
    await page.updateComplete;

    const toggle = page.querySelector<HTMLButtonElement>(".dreams__phase-toggle");
    expect(toggle?.textContent).toContain("On");
    expect(toggle?.disabled).toBe(false);
    expect(toggle?.title).toContain("memory-core's sweep is on as well");

    // The opposite direction stays locked.
    page.dreaming.dreamingStatus = {
      enabled: false,
      reportedEnabled: true,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    page.requestUpdate();
    await page.updateComplete;
    expect(page.querySelector<HTMLButtonElement>(".dreams__phase-toggle")?.disabled).toBe(true);
  });

  it("opens the owner-aware Off confirmation beside a reporting owner", async () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "memory-lancedb-namespaced" },
        entries: { "memory-lancedb-namespaced": { config: { dreaming: { enabled: true } } } },
      },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    page.loadAll = vi.fn(async () => undefined);
    document.body.append(page);
    await page.updateComplete;
    page.dreaming.dreamingStatus = {
      enabled: true,
      reportedEnabled: true,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    page.requestUpdate();
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".dreams__phase-toggle")?.click();
    await page.updateComplete;

    const dialog = page.querySelector("openclaw-modal-dialog");
    expect(dialog?.textContent).toContain("Turn Off Dreaming");
    expect(dialog?.textContent).toContain(
      "memory-lancedb-namespaced keeps running its own dreaming",
    );
    expect(dialog?.textContent).toContain("stays in the cron list and keeps running");
    expect(dialog?.textContent).not.toContain("sweep will stop");

    // Without an owner report the same click opens the generic Off dialog.
    page.dreaming.dreamingStatus = {
      enabled: true,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    page.requestUpdate();
    await page.updateComplete;
    const genericDialog = page.querySelector("openclaw-modal-dialog");
    expect(genericDialog?.textContent).toContain("sweep will stop");
    expect(genericDialog?.textContent).not.toContain("stays in the cron list");
  });

  it("locks turning on for a phases-only report and declines the write", async () => {
    const request = vi.fn(async () => ({}));
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = contextWithGateway({ request } as unknown as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
      },
    });
    page.agentId = "main";
    // The owner reported phases but no `enabled`: still its sweep, still locked.
    page.dreaming.dreamingStatus = {
      enabled: false,
      reportedByProvider: true,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    const container = document.createElement("div");

    render(page.render(), container);

    const toggle = container.querySelector<HTMLButtonElement>(".dreams__phase-toggle");
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.textContent).toContain("Off");

    page.pendingEnabled = true;
    page.toggleConfirmOpen = true;
    await page.confirmToggle();

    expect(request).not.toHaveBeenCalled();
    expect(page.toggleConfirmOpen).toBe(false);
    expect(page.pendingEnabled).toBeNull();
  });

  function renderOwnerReport(status: Record<string, unknown>) {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
      },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    page.dreaming.dreamingStatus = {
      enabled: false,
      reportedByProvider: true,
      ...status,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    const container = document.createElement("div");
    render(page.render(), container);
    return container.querySelector(".dreams__status-label")?.textContent ?? "";
  }

  it("lights the scene for a phases-only owner report with a running phase while the host switch is off", () => {
    const label = renderOwnerReport({
      phases: {
        light: { enabled: false, cron: "", managedCronPresent: false },
        rem: { enabled: true, cron: "15 1 * * *", managedCronPresent: true },
      },
    });
    expect(label).toMatch(/active/i);
  });

  it("keeps the scene idle for a counters-only owner report", () => {
    // Presence still locks the toggle, but nothing reports as running.
    expect(renderOwnerReport({ reportedStats: { promotedToday: 3 } })).toMatch(/idle/i);
  });

  it("keeps the scene lit while a host phase still runs beside an owner that reports off", () => {
    // The next-sweep time below the label comes from that phase, so "Idle"
    // next to a next run would contradict itself.
    const label = renderOwnerReport({
      reportedEnabled: false,
      phases: {
        light: { enabled: true, cron: "0 3 * * *", managedCronPresent: true, nextRunAtMs: 1 },
      },
    });
    expect(label).toMatch(/active/i);
  });

  it("keeps the scene idle when every reported phase is disabled", () => {
    const label = renderOwnerReport({
      phases: {
        light: { enabled: false, cron: "", managedCronPresent: false },
        rem: { enabled: false, cron: "15 1 * * *", managedCronPresent: true },
        deep: { enabled: true, cron: "0 4 * * *", managedCronPresent: false },
      },
    });
    expect(label).toMatch(/idle/i);
  });

  it("shows the owner's promoted count on the scene and memory-core's in Advanced", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "memory-lancedb-namespaced" },
        entries: { "memory-lancedb-namespaced": { config: { dreaming: { enabled: false } } } },
      },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    page.dreaming.dreamingStatus = {
      enabled: false,
      reportedEnabled: true,
      reportedStats: { promotedToday: 4, shortTermCount: 9 },
      shortTermCount: 1,
      promotedToday: 2,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    const container = document.createElement("div");
    render(page.render(), container);
    expect(container.querySelector(".dreams__status-detail")?.textContent).toContain("4 promoted");

    page.viewState.activeSubTab = "advanced";
    render(page.render(), container);
    const advanced = container.querySelector(".dreams-advanced");
    expect(advanced?.querySelector(".dreams-advanced__summary")?.textContent).toContain(
      "1 waiting · 2 promoted today",
    );
    expect(advanced?.textContent).toContain(
      "belong to memory-core; memory-lancedb-namespaced reports its own counters",
    );

    // An owner that reports no count leaves the scene without one instead of
    // borrowing memory-core's.
    page.dreaming.dreamingStatus = {
      enabled: false,
      reportedEnabled: true,
      shortTermCount: 1,
      promotedToday: 2,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    page.viewState.activeSubTab = "scene";
    render(page.render(), container);
    expect(container.querySelector(".dreams__status-detail")?.textContent).not.toContain(
      "promoted",
    );

    // Without an owner report the scene uses memory-core's count and the
    // Advanced description stays generic.
    page.dreaming.dreamingStatus = {
      enabled: true,
      shortTermCount: 1,
      promotedToday: 2,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    render(page.render(), container);
    expect(container.textContent).not.toContain("reports its own counters");
    page.viewState.activeSubTab = "scene";
    render(page.render(), container);
    expect(container.querySelector(".dreams__status-detail")?.textContent).toContain("2 promoted");
  });

  it("keeps the toggle usable when the slot owner reports nothing", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
      },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    page.dreaming.dreamingStatus = {
      enabled: false,
    } as NonNullable<DreamingState["dreamingStatus"]>;
    const container = document.createElement("div");

    render(page.render(), container);

    const toggle = container.querySelector<HTMLButtonElement>(".dreams__phase-toggle");
    expect(toggle?.hasAttribute("title")).toBe(false);
    expect(container.textContent).not.toContain("runs its own dreaming");
  });

  it("omits default provenance when engine Off has no latent override", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: { slots: { memory: "none" } },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    const container = document.createElement("div");

    render(page.render(), container);

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
    document.body.append(page);
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
    document.body.append(page);
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
    document.body.append(page);
    await page.updateComplete;
    page.viewState.wikiPreviewOpen = true;
    page.viewState.wikiPreviewLoading = true;
    page.viewState.wikiPreviewContent = "support-only";

    page.agentId = "marketing";
    await page.updateComplete;

    expect(page.viewState.wikiPreviewOpen).toBe(false);
    expect(page.viewState.wikiPreviewLoading).toBe(false);
    expect(page.viewState.wikiPreviewContent).toBe("");
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
        agents: { entries: { main: { default: true }, support: {} } },
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
        const picker = page.locator(".memory-page .agent-scope-control openclaw-agent-select");
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
          .poll(
            () =>
              page.evaluate(
                () =>
                  (
                    document.querySelector("openclaw-app") as HTMLElement & {
                      runtime?: { context: { gateway: { snapshot: { phase: string } } } };
                    }
                  ).runtime?.context.gateway.snapshot.phase,
              ),
            { timeout: 15_000 },
          )
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
