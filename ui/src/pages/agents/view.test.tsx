import { createMemo } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChannelAccountSnapshot, ToolsCatalogResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n, t } from "../../i18n/index.ts";
import { zh_CN } from "../../i18n/locales/zh-CN.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import { formatNextRun } from "../../lib/presenter.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid as mountConnected } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker } from "../../test-helpers/select-picker.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { createAgentCronPresenter } from "./agent-cron-presenter.ts";
import { createAgentFileEditors } from "./agent-file-state.test-helpers.ts";
import {
  createAgentViewTestProps as createProps,
  createCronJob,
  inertAgentFileControls,
  primaryModelPicker,
} from "./agents-view.test-helpers.ts";
import { AgentFiles } from "./panels-files.tsx";
import { AgentChannels } from "./panels-status-files.tsx";
import { Agents, type AgentsProps } from "./view.tsx";

function config(configForm: ReturnType<typeof createProps>["config"]["configForm"]) {
  return {
    ...createProps().config,
    configForm,
  };
}

const views = new WeakMap<HTMLElement, ReturnType<typeof mountSolid<AgentsProps>>>();

function renderView(overrides: Partial<ReturnType<typeof createProps>>, container: HTMLElement) {
  const props = createProps(overrides);
  const view = views.get(container);
  if (view) {
    view.update(props);
  } else {
    views.set(container, mountSolid(Agents, props, container));
  }
}

function renderFiles(
  params: Partial<
    Parameters<typeof AgentFiles>[0] & ReturnType<Parameters<typeof AgentFiles>[0]["readData"]>
  > &
    Pick<
      ReturnType<Parameters<typeof AgentFiles>[0]["readData"]>,
      "agentFilesList" | "agentFileActive" | "agentFileEditors"
    >,
  container: HTMLElement,
) {
  mountSolid(
    AgentFiles,
    {
      readData() {
        return { ...createProps().readData(), ...this };
      },
      presentationRetired: createProps().presentationRetired,
      agentId: "alpha",
      listRead: null,
      agentFileConflict: null,
      canWrite: true,
      agentFilesLoading: false,
      agentFileRead: null,
      agentFileOutcome: null,
      agentFileSaving: false,
      ...inertAgentFileControls,
      ...params,
    },
    container,
  );
}

function directText(element: Element | null | undefined): string | undefined {
  return Array.from(element?.childNodes ?? [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function expectAgentTab(container: Element, text: string): HTMLElement & { disabled: boolean } {
  const button = Array.from(
    container.querySelectorAll<HTMLElement & { disabled: boolean }>(".hub-tab"),
  ).find((candidate) => directText(candidate) === text);
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Expected agent tab "${text}"`);
  }
  return button;
}

describe("renderAgents", () => {
  it("announces an agent list failure as an alert", async () => {
    const container = document.createElement("div");
    renderView({ listRead: Promise.resolve({ error: "Agent list unavailable" }) }, container);
    await waitForSolid(() =>
      expect(
        Array.from(container.querySelectorAll('[role="alert"]'), (alert) =>
          alert.textContent?.trim(),
        ),
      ).toEqual(["Agent list unavailable"]),
    );
  });

  it("renders the selected agent's tool catalog loading state", async () => {
    const mounted = mountConnected(() => {
      const readCatalog = createMemo(() => new Promise<ToolsCatalogResult>(() => {}));
      const props = createProps();
      return (
        <Agents
          {...props}
          tools={{ ...props.tools, readCatalog }}
          readData={() => ({ ...props.readData(), agentsPanel: "tools" })}
        />
      );
    });
    await vi.dynamicImportSettled();

    await waitForSolid(() =>
      expect(
        mounted.container.querySelector(
          `.settings-loading-skeleton[aria-label="${t("agentTools.loadingCatalog")}"]`,
        ),
      ).not.toBeNull(),
    );
  });

  it("renders the active agent tab and selects a different panel", () => {
    const container = document.createElement("div");
    const onSelectPanel = vi.fn();
    renderView(
      { onSelectPanel, readData: () => ({ ...createProps().readData(), agentsPanel: "files" }) },
      container,
    );

    expect(container.querySelector("#agents-tab-files")?.hasAttribute("active")).toBe(true);
    expectAgentTab(container, "Tools").dispatchEvent(
      new MouseEvent("click", { detail: 1, bubbles: true }),
    );
    expect(onSelectPanel).toHaveBeenCalledWith("tools");
  });

  it("prefills the identity editor from the fetched agent identity", () => {
    const container = document.createElement("div");
    renderView(
      {
        agentIdentityById: {
          beta: { agentId: "beta", name: "Fetched Beta", avatar: "", emoji: "🦊" },
        },
      },
      container,
    );

    expect(
      container.querySelector<HTMLInputElement>(".agent-identity-editor__fields input")?.value,
    ).toBe("Fetched Beta");
    expect(
      container
        .querySelector(".agent-identity-editor__avatar .identity-avatar__text")
        ?.getAttribute("data-avatar"),
    ).toBe("🦊");
  });

  it("renders and counts a server-scoped default-agent cron job without an explicit agentId", async () => {
    const job = createCronJob("implicit-default-job", {
      name: "Implicit default-agent reminder",
    });
    const nextWakeAtMs = Date.now() + 60_000;
    const scopedNextWakeAtMs = nextWakeAtMs + 3_600_000;
    const container = document.createElement("div");
    renderView(
      {
        selectedAgentId: "alpha",
        cron: { ...createProps().cron },
        readData: () => ({
          ...createProps().readData(),
          agentsPanel: "cron",
          cron: {
            ...createProps().readData().cron,
            cronStatus: { enabled: true, triggersEnabled: true, jobs: 51, nextWakeAtMs },
            cronJobs: [job],
            cronJobsTotal: 1,
            cronJobsHasMore: false,
            cronJobsLoadingMore: false,
            cronScopedTotal: 1,
            cronScopedNextWakeAtMs: scopedNextWakeAtMs,
            cronLoading: false,
            cronError: null,
          },
        }),
      },
      container,
    );

    await vi.dynamicImportSettled();

    await waitForSolid(() =>
      expect(container.textContent).toContain("Implicit default-agent reminder"),
    );
    expect(
      expectAgentTab(container, t("agents.tabs.cronJobs")).querySelector(".hub-tab__badge--count")
        ?.textContent,
    ).toContain("1");

    const schedulerRows = [...container.querySelectorAll(".settings-row")];
    const jobsRow = schedulerRows.find(
      (row) =>
        row.querySelector(".settings-row__title")?.textContent === t("agents.cronPanel.jobs"),
    );
    const nextWakeRow = schedulerRows.find(
      (row) =>
        row.querySelector(".settings-row__title")?.textContent === t("agents.cronPanel.nextWake"),
    );
    expect(jobsRow?.querySelector(".settings-row__control")?.textContent?.trim()).toBe("1");
    expect(nextWakeRow?.querySelector(".settings-row__control")?.textContent?.trim()).toBe(
      formatNextRun(scopedNextWakeAtMs),
    );
    expect(nextWakeRow?.textContent).not.toContain(formatNextRun(nextWakeAtMs));
  });

  it("shows a rejected agent jobs refresh beside retained jobs without hiding scheduler feedback", async () => {
    const client = createTestGatewayClient(async (method) => {
      throw new Error(
        method === "cron.status"
          ? "Scheduler status is unavailable."
          : "Agent jobs could not be refreshed.",
      );
    });
    const cronState = {
      ...createInitialCronState({ client, connected: true }),
      cronAgentId: "alpha",
      cronError: "Scheduler status is unavailable.",
      cronJobs: [createCronJob("retained-job", { name: "Retained reminder" })],
    };
    const container = document.createElement("div");
    const presenter = createAgentCronPresenter({
      currentState: () => cronState,
      readState: () => cronState,
      canCall: () => true,
      publish: () => renderCurrent(),
    });
    const renderCurrent = (): void => {
      renderView(
        {
          selectedAgentId: "alpha",
          cron: {
            ...createProps().cron,
            read: presenter.read,
            onRefresh: presenter.onRefresh,
          },
          readData: () => ({ ...createProps().readData(), agentsPanel: "cron", cron: cronState }),
        },
        container,
      );
    };
    renderCurrent();
    await waitForSolid(() => expect(container.textContent).toContain("Retained reminder"));
    const scheduler = [...container.querySelectorAll(".settings-section")].find(
      (section) =>
        section.querySelector("h2")?.textContent === t("agents.cronPanel.schedulerTitle"),
    );
    const refresh = scheduler?.querySelector<HTMLButtonElement>("button");
    expect(refresh).toBeInstanceOf(HTMLButtonElement);
    refresh?.click();

    await waitForSolid(() => {
      const jobs = [...container.querySelectorAll(".settings-section")].find(
        (section) =>
          section.querySelector("h2")?.textContent === t("agents.cronPanel.agentJobsTitle"),
      );
      expect(jobs?.querySelector('[role="alert"]')?.textContent).toContain(
        "Agent jobs could not be refreshed.",
      );
      expect(jobs?.textContent).toContain("Retained reminder");
      expect(container.textContent).toContain("Scheduler status is unavailable.");
    });
  });

  it("loads and renders the selected agent's 51st cron job when Load more is clicked", async () => {
    const snapshotRevision = "agents-view-cron-fixture";
    const jobs = Array.from({ length: 50 }, (_, index) =>
      createCronJob(`main-${index}`, { agentId: "alpha" }),
    );
    const lastJob = createCronJob("main-50", {
      agentId: "alpha",
      name: "Fifty-first agent reminder",
    });
    const request = vi.fn(async () => ({
      jobs: [lastJob],
      snapshotRevision,
      total: 51,
      offset: 50,
      limit: 50,
      nextOffset: null,
      hasMore: false,
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const cronState = {
      ...createInitialCronState({ client, connected: true }),
      cronAgentId: "alpha",
      cronJobs: jobs,
      cronJobsSnapshotRevision: snapshotRevision,
      cronJobsTotal: 51,
      cronJobsHasMore: true,
      cronJobsNextOffset: 50,
    };
    const container = document.createElement("div");
    const presenter = createAgentCronPresenter({
      currentState: () => cronState,
      readState: () => cronState,
      canCall: () => true,
      publish: () => renderCurrentPage(),
    });
    const renderCurrentPage = (): void => {
      renderView(
        {
          selectedAgentId: "alpha",
          cron: {
            ...createProps().cron,
            read: presenter.read,
            onLoadMore: presenter.onLoadMore,
          },
          readData: () => ({
            ...createProps().readData(),
            agentsPanel: "cron",
            cron: {
              ...createProps().readData().cron,
              cronStatus: { enabled: true, triggersEnabled: true, jobs: 80, nextWakeAtMs: null },
              cronJobs: cronState.cronJobs,
              cronJobsTotal: cronState.cronJobsTotal,
              cronJobsHasMore: cronState.cronJobsHasMore,
              cronJobsLoadingMore: cronState.cronJobsLoadingMore,
              cronScopedTotal: 51,
              cronScopedNextWakeAtMs: null,
              cronLoading: cronState.cronLoading,
              cronError: cronState.cronError,
              cronNotice: cronState.cronNotice,
            },
          }),
        },
        container,
      );
    };
    renderCurrentPage();
    await waitForSolid(() => expect(container.querySelector(".cron-load-more")).not.toBeNull());

    expect(
      expectAgentTab(container, t("agents.tabs.cronJobs")).querySelector(".hub-tab__badge--count")
        ?.textContent,
    ).toContain("51");
    expect(container.textContent).not.toContain(lastJob.name);

    const loadMore = container.querySelector<HTMLButtonElement>(".cron-load-more");
    expect(loadMore?.textContent?.trim()).toBe(t("cron.list.loadMore"));
    loadMore?.click();
    expect(container.querySelector<HTMLButtonElement>(".cron-load-more")?.disabled).toBe(true);

    await vi.waitFor(() => expect(container.textContent).toContain(lastJob.name));
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "alpha", limit: 50, offset: 50 }),
    );
    expect(container.querySelector(".cron-load-more")).toBeNull();
  });

  it("renders Memory after Automations and scopes the panel to the selected agent", async () => {
    const container = document.createElement("div");
    const request = vi.fn(async (method: string) =>
      method === "doctor.memory.status" ? { dreaming: null } : { found: false, path: "DREAMS.md" },
    );
    const client = createTestGatewayClient(request);
    const context = {
      gateway: createApplicationGateway({
        ...createApplicationGateway().gateway.snapshot,
        client,
        phase: "connected",
      }).gateway,
      runtimeConfig: {
        state: { configForm: null, configSnapshot: null },
        ensureLoaded: async () => undefined,
        subscribe: () => () => undefined,
      },
    } as unknown as ApplicationContext;
    mountSolid(
      (props: AgentsProps) => (
        <ApplicationProvider value={context}>
          <Agents {...props} />
        </ApplicationProvider>
      ),
      createProps({ readData: () => ({ ...createProps().readData(), agentsPanel: "memory" }) }),
      container,
    );

    await vi.dynamicImportSettled();

    const tabs = [...container.querySelectorAll(".agents-hub-tabs .hub-tab")].map((tab) =>
      directText(tab),
    );
    expect(tabs.slice(-2)).toEqual([t("agents.tabs.cronJobs"), t("agents.tabs.memory")]);
    await waitForSolid(() =>
      expect(
        container.querySelector("openclaw-agent-memory-panel .agent-memory-panel__header"),
      ).not.toBeNull(),
    );
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "beta" }),
    );
  });

  it("updates the configured primary model selection when the active agent changes", async () => {
    const container = document.createElement("div");
    const configForm = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        entries: { alpha: {}, beta: {} },
      },
    };

    renderView(
      {
        selectedAgentId: "alpha",
        config: config(configForm),
      },
      container,
    );

    await updatePickers(container);
    const defaultPicker = primaryModelPicker(container);
    await openPicker(defaultPicker!);
    expect(
      defaultPicker
        ?.querySelector('[role="option"][aria-selected="true"]')
        ?.getAttribute("data-value"),
    ).toBe("openai/gpt-5.4");

    renderView(
      {
        selectedAgentId: "beta",
        config: config(configForm),
      },
      container,
    );

    await updatePickers(container);
    await openPicker(primaryModelPicker(container)!);
    const inheritedSelection = primaryModelPicker(container)?.querySelector(
      '[role="option"][aria-selected="true"]',
    );
    expect(inheritedSelection?.textContent?.trim()).toBe("Inherit default (openai/gpt-5.4)");
  });

  it("shows canonical model names alongside configured aliases in agent options", async () => {
    const container = document.createElement("div");
    const configForm = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-8" },
          models: {
            "anthropic/claude-opus-4-8": { alias: "opus" },
            "anthropic/claude-sonnet-5": { alias: "sonnet" },
            "nvidia/moonshotai/kimi-k2.5": { alias: "Kimi K2.5 (NVIDIA)" },
            "local/unlisted-model": { alias: "My local model" },
          },
        },
        entries: {
          alpha: {
            models: {
              "local/unlisted-model": { alias: "Alpha local model" },
              "google/gemini-3-flash-preview": { alias: "Alpha Flash" },
            },
          },
          beta: {},
        },
      },
    };

    renderView(
      {
        selectedAgentId: "alpha",
        config: config(configForm),
        overview: {
          ...createProps().overview,
          modelCatalog: [
            {
              id: "claude-opus-4-8",
              alias: "opus",
              name: "Opus 4.8",
              provider: "anthropic",
            },
            {
              id: "claude-sonnet-5",
              alias: "sonnet",
              name: "Sonnet 5",
              provider: "anthropic",
            },
            {
              id: "moonshotai/kimi-k2.5",
              alias: "Kimi K2.5 (NVIDIA)",
              name: "Kimi K2.5",
              provider: "nvidia",
            },
          ],
        },
      },
      container,
    );

    await updatePickers(container);
    const select = primaryModelPicker(container);
    await openPicker(select!);
    expect(
      select?.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
    ).toBe("anthropic/claude-opus-4-8");
    const options = new Map(
      Array.from(select?.querySelectorAll('[role="option"]') ?? []).map((option) => [
        option.getAttribute("data-value"),
        option.querySelector(".picker-select__label")?.textContent?.trim(),
      ]),
    );

    expect(options.get("anthropic/claude-opus-4-8")).toBe("Opus 4.8 · opus");
    expect(options.get("anthropic/claude-sonnet-5")).toBe("Sonnet 5 · sonnet");
    expect(options.get("nvidia/moonshotai/kimi-k2.5")).toBe("Kimi K2.5 (NVIDIA)");
    expect(options.get("local/unlisted-model")).toBe("Alpha local model (local/unlisted-model)");
    expect(options.get("google/gemini-3-flash-preview")).toBe(
      "Alpha Flash (google/gemini-3-flash-preview)",
    );
  });

  it("does not display inherited fallback chips for an authored primary", () => {
    const model = { primary: "openai/gpt-5.4" };
    const container = document.createElement("div");
    const fallback = "anthropic/claude-sonnet-4-6";

    renderView(
      {
        selectedAgentId: "beta",
        config: config({
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4", fallbacks: [fallback] },
            },
            entries: { alpha: {}, beta: { model } },
          },
        }),
      },
      container,
    );

    const field = container.querySelector<HTMLElement>("openclaw-multi-select.agent-fallbacks");
    expect(field).not.toBeNull();
    expect(field?.querySelectorAll(".multi-select__chip")).toHaveLength(0);
  });

  it("shows the skills count only for the selected agent's report", async () => {
    const container = document.createElement("div");
    renderView(
      {
        agentSkills: { ...createProps().agentSkills, filter: "" },
        readData: () => ({
          ...createProps().readData(),
          agentSkillsReport: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [createSkill()],
          },
          agentSkillsAgentId: "alpha",
        }),
      },
      container,
    );
    await Promise.resolve();

    let skillsTab = expectAgentTab(container, "Skills");

    expect(skillsTab.textContent?.trim()).toBe("Skills");

    renderView(
      {
        agentSkills: { ...createProps().agentSkills, filter: "" },
        readData: () => ({
          ...createProps().readData(),
          agentSkillsReport: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [createSkill()],
          },
          agentSkillsAgentId: "beta",
        }),
      },
      container,
    );
    await Promise.resolve();

    skillsTab = expectAgentTab(container, "Skills");

    expect(directText(skillsTab)).toBe("Skills");
    expect(skillsTab.querySelector(".hub-tab__badge--count")?.textContent).toBe("1");
  });

  it("localizes agent tabs and the channel refresh never state", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");

    try {
      renderView(
        {
          channels: { ...createProps().channels },
          readData: () => ({ ...createProps().readData(), agentsPanel: "channels" }),
          readChannels: () => ({
            ...createProps().readChannels(),
            channelsSnapshot: null,
            channelsRead: null,
            channelsError: null,
            channelsLastSuccess: null,
          }),
        },
        container,
      );
      await Promise.resolve();

      const tabLabels = Array.from(
        container.querySelectorAll<HTMLElement>(".agents-hub-tabs .hub-tab"),
      ).map((button) => button.textContent?.trim());

      const chinese = flattenTranslations(zh_CN);
      const tabs = ["overview", "files", "tools", "skills", "channels", "cronJobs", "memory"];
      expect(tabLabels).toEqual(tabs.map((tab) => chinese.get(`agents.tabs.${tab}`)));
      const lastRefresh = chinese
        .get("agents.channels.lastRefresh")
        ?.replace("{time}", chinese.get("common.never") ?? "");
      await waitForSolid(() =>
        expect(
          Array.from(container.querySelectorAll(".settings-section__desc"), (desc) =>
            desc.textContent?.replace(/\s+/gu, " ").trim(),
          ),
        ).toContain(`${chinese.get("agents.channels.subtitle")} ${lastRefresh}`),
      );
    } finally {
      await i18n.setLocale("en");
      vi.unstubAllGlobals();
    }
  });
});

describe("renderAgentChannels", () => {
  function renderChannelStatus(accounts: ChannelAccountSnapshot[]) {
    const container = document.createElement("div");
    mountSolid(
      AgentChannels,
      {
        context: {
          workspace: "default",
          model: "—",
          runtime: "pi",
          identityName: "Alpha",
          identityAvatar: "—",
          skillsLabel: "all skills",
          isDefault: true,
        },
        configForm: null,
        readState: () => ({
          channelsSnapshot: {
            ts: Date.now(),
            channelOrder: ["discord"],
            channelLabels: { discord: "Discord" },
            channels: {},
            channelAccounts: { discord: accounts },
            channelDefaultAccountId: { discord: "default" },
          },
          channelsRead: null,
          channelsError: null,
          channelsLastSuccess: Date.now(),
        }),
        onRefresh: () => undefined,
        onSelectPanel: () => undefined,
      },
      container,
    );
    const row = Array.from(container.querySelectorAll(".settings-row")).find(
      (candidate) => candidate.querySelector(".settings-row__title")?.textContent === "Discord",
    );
    const status = row?.querySelector(".settings-status");
    return {
      className: status?.className,
      label: status?.textContent?.trim(),
    };
  }

  it("does not let a successful probe override an explicitly stopped runtime", () => {
    expect(
      renderChannelStatus([
        {
          accountId: "stopped",
          connected: false,
          running: false,
          probe: { ok: true },
        },
      ]),
    ).toEqual({
      className: "settings-status settings-status--warn",
      label: "0/1 connected",
    });
  });

  it("counts live runtimes and preserves probe fallback for passive channels", () => {
    expect(
      renderChannelStatus([
        { accountId: "connected", connected: true, probe: { ok: false } },
        { accountId: "running", running: true, probe: { ok: false } },
        { accountId: "passive", probe: { ok: true } },
        { accountId: "unreachable", probe: { ok: false } },
      ]),
    ).toEqual({
      className: "settings-status settings-status--ok",
      label: "3/4 connected",
    });
  });
});

describe("renderAgentFiles", () => {
  it("does not accept another file selection while a file request is loading", () => {
    const container = document.createElement("div");
    const onSelectFile = vi.fn();

    renderFiles(
      {
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "AGENTS.md",
              path: "/tmp/workspace/AGENTS.md",
              missing: false,
            },
            {
              name: "SOUL.md",
              path: "/tmp/workspace/SOUL.md",
              missing: false,
            },
          ],
        },
        agentFilesLoading: true,
        agentFileActive: "AGENTS.md",
        agentFileEditors: createAgentFileEditors({
          content: { "AGENTS.md": "# Instructions" },
          draft: { "AGENTS.md": "# Instructions" },
        }),

        onSelectFile,
      },
      container,
    );

    const soulTab = expectAgentTab(container, "SOUL");
    expect(soulTab.disabled).toBe(true);
    soulTab.click();
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  // A missing SOUL.md is a normal workspace state, so it belongs in the add picker
  // instead of a permanently-badged MISSING tab; a missing AGENTS.md is a real fault.
  it("offers normally-absent files in the add picker and badges only real faults", () => {
    const container = document.createElement("div");
    const onSelectFile = vi.fn();

    renderFiles(
      {
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            { name: "AGENTS.md", path: "/tmp/workspace/AGENTS.md", missing: true },
            {
              name: "SOUL.md",
              path: "/tmp/workspace/SOUL.md",
              missing: true,
              expectedAbsent: true,
            },
            {
              name: "MEMORY.md",
              path: "/tmp/workspace/MEMORY.md",
              missing: true,
              expectedAbsent: true,
            },
          ],
        },
        agentFileActive: "AGENTS.md",
        agentFileEditors: createAgentFileEditors({
          content: { "AGENTS.md": "" },
          draft: { "AGENTS.md": "" },
        }),

        onSelectFile,
      },
      container,
    );

    const tabLabels = Array.from(
      container.querySelectorAll<HTMLElement>(".agent-files-hub-tabs .hub-tab"),
    ).map((tab) => directText(tab));
    expect(tabLabels).toStrictEqual(["AGENTS"]);
    expect(container.querySelector(".agent-files-hub-tabs .hub-tab__badge")?.textContent).toBe(
      "missing",
    );

    const picker = container.querySelector<HTMLSelectElement>(".agent-tab-add");
    expect(picker).not.toBeNull();
    expect(Array.from(picker?.options ?? []).map((option) => option.value)).toStrictEqual([
      "",
      "SOUL.md",
      "MEMORY.md",
    ]);

    if (!picker) {
      throw new Error("expected add picker");
    }
    picker.value = "SOUL.md";
    picker.dispatchEvent(new Event("change"));
    expect(onSelectFile).toHaveBeenCalledWith("SOUL.md");
    // The picker is an action, not a selection: it resets so the same file can be
    // re-picked after the operator switches tabs.
    expect(picker.value).toBe("");
  });

  it.each([
    ["no conflict", true, null, true],
    ["missing required file conflict", false, "SOUL.md", false],
  ] as const)(
    "shows current file creation guidance with %s",
    (_label, expectedAbsent, conflict, showMissing) => {
      const container = document.createElement("div");
      const onSelectFile = vi.fn();
      const onFileReload = vi.fn();
      const onFileOverwrite = vi.fn();

      renderFiles(
        {
          agentFilesList: {
            agentId: "alpha",
            workspace: "/tmp/workspace",
            files: [
              { name: "AGENTS.md", path: "/tmp/workspace/AGENTS.md", missing: false },
              {
                name: "SOUL.md",
                path: "/tmp/workspace/SOUL.md",
                missing: true,
                expectedAbsent,
              },
            ],
          },
          agentFileActive: "SOUL.md",
          agentFileEditors: createAgentFileEditors({
            content: { "SOUL.md": "" },
            draft: { "SOUL.md": "Unsaved instructions" },
          }),

          onSelectFile,
          agentFileConflict: conflict,
          onFileReload,
          onFileOverwrite,
        },
        container,
      );

      const tabLabels = Array.from(
        container.querySelectorAll<HTMLElement>(".agent-files-hub-tabs .hub-tab"),
      ).map((tab) => directText(tab));
      expect(tabLabels).toStrictEqual(["AGENTS", "SOUL"]);
      expect(container.querySelector(".agent-tab-add")).toBeNull();
      expect(container.querySelectorAll(".agent-files-hub-tabs .hub-tab__badge")).toHaveLength(0);
      expect(
        container.querySelector('[id="agent-files-tab-SOUL.md"]')?.hasAttribute("active"),
      ).toBe(true);
      container
        .querySelector('[id="agent-files-tab-AGENTS.md"]')
        ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      expect(onSelectFile).toHaveBeenCalledWith("AGENTS.md");
      expect(container.querySelector(".callout.info")?.textContent?.trim()).toBe(
        showMissing
          ? "This file does not exist yet. Saving will create it in the agent workspace."
          : undefined,
      );
      expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
        "Unsaved instructions",
      );
      const resolutionButtons =
        container.querySelectorAll<HTMLButtonElement>(".callout.danger button");
      expect(Array.from(resolutionButtons, (button) => button.textContent?.trim())).toEqual(
        showMissing ? [] : ["Reload", "Overwrite"],
      );
      if (!showMissing) {
        resolutionButtons.forEach((button) => button.click());
        expect(onFileReload).toHaveBeenCalledWith("SOUL.md");
        expect(onFileOverwrite).toHaveBeenCalledWith("SOUL.md");
      }
    },
  );
});

describe("renderAgents toolbar", () => {
  it.each([false, true])(
    "keeps standalone creation with no selectable agents (system: %s)",
    (system) => {
      const container = document.createElement("div");
      const onCreateAgent = vi.fn();
      renderView(
        {
          selectedAgentId: "alpha",
          onCreateAgent,
          readData: () => ({
            ...createProps().readData(),
            agentsList: {
              defaultId: "alpha",
              mainKey: "main",
              scope: "per-sender",
              agents: system ? [{ id: "alpha", kind: "system" }] : [],
            },
          }),
        },
        container,
      );

      expect(container.querySelector("openclaw-agent-select")).toBeNull();
      expect(container.querySelector("#agent-panel")).toBeNull();
      expect(container.textContent).toContain(t("agents.selectSubtitle"));
      const createButton = container.querySelector<HTMLButtonElement>(".agents-create-btn");
      expect(createButton?.textContent?.trim()).toBe(t("custodian.newAgent"));
      createButton?.click();
      expect(onCreateAgent).toHaveBeenCalledOnce();
    },
  );

  it("keeps unavailable creation visible and disabled with a recovery reason", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onCreateAgent = vi.fn();
    try {
      renderView(
        {
          access: {
            ...createProps().access,
            canCreateAgent: false,
          },
          onCreateAgent,
          readData: () => ({
            ...createProps().readData(),
            agentsList: {
              defaultId: "alpha",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "alpha" }, { id: "beta" }],
            },
          }),
        },
        container,
      );
      expect(container.querySelector("openclaw-agent-select")).toBeNull();
      const createButton = container.querySelector<HTMLButtonElement>(".agents-create-btn");
      expect(createButton).not.toBeNull();
      expect(createButton?.disabled).toBe(true);
      expect(createButton?.title).toContain("openclaw.chat");
      expect(createButton?.title).toContain("operator.admin");
      expect(createButton?.title).toContain("reconnect");
      createButton?.click();
      expect(onCreateAgent).not.toHaveBeenCalled();
    } finally {
      container.remove();
    }
  });
});

it("retires agent config errors during save and retains all owner error messages", () => {
  const container = document.createElement("div");
  const failedConfig = {
    ...config({ agents: { entries: { beta: {} } } }),
    configFormDirty: true,
    lastError: "mock validation failure",
  };
  renderView({ config: failedConfig }, container);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(failedConfig.lastError);
  renderView({ config: { ...failedConfig, configSaving: true, lastError: null } }, container);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  for (const lastError of [failedConfig.lastError, "Config could not be loaded"]) {
    renderView({ config: { ...failedConfig, lastError } }, container);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(lastError);
  }
});

it.each([
  { name: "paused authorized job", enabled: false, canRunCron: true, canRun: true },
  { name: "enabled unauthorized job", enabled: true, canRunCron: false, canRun: false },
])(
  "preserves edit links and gates Run Now for a $name",
  async ({ enabled, canRunCron, canRun }) => {
    const container = document.createElement("div");
    const onCronRunNow = vi.fn();
    const job = createCronJob("job /?&", {
      name: "Weekly report",
      agentId: "alpha",
      enabled,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Summarize notes." },
      state: {},
    });
    const props = createProps({
      selectedAgentId: "alpha",
      basePath: "/gateway",
      readData: () => ({ ...createProps().readData(), agentsPanel: "cron" }),
    });
    renderView(
      {
        ...props,
        access: { ...props.access, canRunCron },
        cron: { ...props.cron, onRunNow: onCronRunNow },
        readData: () => ({
          ...props.readData(),
          cron: { ...props.readData().cron, cronJobs: [job] },
        }),
      },
      container,
    );
    await waitForSolid(() => expect(container.textContent).toContain("Weekly report"));
    const link = [...container.querySelectorAll("a")].find(
      (entry) => entry.textContent?.trim() === "Edit",
    );
    expect(link?.getAttribute("href")).toBe("/gateway/automations?job=job%20%2F%3F%26");

    const jobRow = [...container.querySelectorAll(".settings-row")].find(
      (row) => row.querySelector(".settings-row__title")?.textContent?.trim() === job.name,
    );
    const runNow = [...(jobRow?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Run Now",
    );
    expect(runNow).toBeInstanceOf(HTMLButtonElement);
    expect(runNow?.disabled).toBe(!canRun);
    runNow?.click();
    if (canRun) {
      expect(onCronRunNow).toHaveBeenCalledTimes(1);
      expect(onCronRunNow).toHaveBeenCalledWith(job.id);
    } else {
      expect(onCronRunNow).not.toHaveBeenCalled();
    }
  },
);
