import { describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChannelAccountSnapshot, CronJob } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { MultiSelect } from "../../components/multi-select.ts";
import { i18n, t } from "../../i18n/index.ts";
import { zh_CN } from "../../i18n/locales/zh-CN.ts";
import { createInitialCronState, loadCronJobsPage } from "../../lib/cron/index.ts";
import { formatNextRun } from "../../lib/presenter.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { createAgentFileEditors } from "./agent-file-state.test-helpers.ts";
import {
  createAgentViewTestProps as createProps,
  inertAgentFileControls,
  primaryModelPicker,
} from "./agents-view.test-helpers.ts";
import { AgentFiles } from "./panels-files.tsx";
import { AgentChannels } from "./panels-status-files.tsx";
import { Agents, type AgentsProps } from "./view.tsx";

function config(configForm: ReturnType<typeof createProps>["config"]["configForm"]) {
  return {
    configForm,
    configSnapshot: null,
    configLoading: false,
    configSaving: false,
    configFormDirty: false,
    lastError: null,
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
  params: Partial<Parameters<typeof AgentFiles>[0]> &
    Pick<
      Parameters<typeof AgentFiles>[0],
      "agentFilesList" | "agentFileActive" | "agentFileEditors"
    >,
  container: HTMLElement,
) {
  mountSolid(
    AgentFiles,
    {
      agentId: "alpha",
      canWrite: true,
      agentFilesLoading: false,
      agentFilesError: null,
      agentFileSaving: false,
      ...inertAgentFileControls,
      ...params,
    },
    container,
  );
}

function createCronJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: `Scheduled job ${id}`,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    ...overrides,
  } as CronJob;
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
  it("renders the selected agent's tool catalog loading state", () => {
    const container = document.createElement("div");
    const props = createProps();
    renderView(
      { activePanel: "tools", tools: { ...props.tools, toolsCatalogLoading: true } },
      container,
    );
    expect(container.querySelector('.settings-loading-skeleton[aria-busy="true"]')).not.toBeNull();
  });

  it("renders the active agent tab and selects a different panel", () => {
    const container = document.createElement("div");
    const onSelectPanel = vi.fn();
    renderView({ activePanel: "files", onSelectPanel }, container);

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

  it("renders and counts a server-scoped default-agent cron job without an explicit agentId", () => {
    const job = createCronJob("implicit-default-job", {
      name: "Implicit default-agent reminder",
    });
    const nextWakeAtMs = Date.now() + 60_000;
    const scopedNextWakeAtMs = nextWakeAtMs + 3_600_000;
    const container = document.createElement("div");
    renderView(
      {
        activePanel: "cron",
        selectedAgentId: "alpha",
        cron: {
          ...createProps().cron,
          status: { enabled: true, triggersEnabled: true, jobs: 51, nextWakeAtMs },
          jobs: [job],
          jobsTotal: 1,
          jobsHasMore: false,
          jobsLoadingMore: false,
          scopedTotal: 1,
          scopedNextWakeAtMs,
          loading: false,
          error: null,
        },
      },
      container,
    );

    expect(container.textContent).toContain("Implicit default-agent reminder");
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
    const renderCurrentPage = (): void => {
      renderView(
        {
          activePanel: "cron",
          selectedAgentId: "alpha",
          cron: {
            ...createProps().cron,
            status: { enabled: true, triggersEnabled: true, jobs: 80, nextWakeAtMs: null },
            jobs: cronState.cronJobs,
            jobsTotal: cronState.cronJobsTotal,
            jobsHasMore: cronState.cronJobsHasMore,
            jobsLoadingMore: cronState.cronJobsLoadingMore,
            scopedTotal: 51,
            scopedNextWakeAtMs: null,
            loading: cronState.cronLoading,
            error: cronState.cronError,
            onLoadMore: () => {
              const nextPage = loadCronJobsPage(cronState, { append: true, tableFilters: true });
              renderCurrentPage();
              void nextPage.then(renderCurrentPage);
            },
          },
        },
        container,
      );
    };
    renderCurrentPage();

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

  it("renders Memory after Automations and scopes the panel to the selected agent", () => {
    const container = document.createElement("div");
    const context = {
      gateway: createApplicationGateway().gateway,
      runtimeConfig: {
        state: { configForm: null, configSnapshot: null },
        subscribe: () => () => undefined,
      },
    } as unknown as ApplicationContext;
    mountSolid(
      (props: AgentsProps) => (
        <ApplicationProvider value={context}>
          <Agents {...props} />
        </ApplicationProvider>
      ),
      createProps({ activePanel: "memory" }),
      container,
    );

    const tabs = [...container.querySelectorAll(".agents-hub-tabs .hub-tab")].map((tab) =>
      directText(tab),
    );
    expect(tabs.slice(-2)).toEqual([t("agents.tabs.cronJobs"), t("agents.tabs.memory")]);
    const panel = container.querySelector<HTMLElement & { agentId: string }>(
      "openclaw-agent-memory-panel",
    );
    expect(panel?.agentId).toBe("beta");
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

    const field = container.querySelector<MultiSelect>("openclaw-multi-select.agent-fallbacks");
    expect(field?.value).toEqual([]);
  });

  it("shows the skills count only for the selected agent's report", async () => {
    const container = document.createElement("div");
    renderView(
      {
        agentSkills: {
          ...createProps().agentSkills,
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [createSkill()],
          },
          loading: false,
          error: null,
          activeAgentId: "alpha",
          filter: "",
        },
      },
      container,
    );
    await Promise.resolve();

    let skillsTab = expectAgentTab(container, "Skills");

    expect(skillsTab.textContent?.trim()).toBe("Skills");

    renderView(
      {
        agentSkills: {
          ...createProps().agentSkills,
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [createSkill()],
          },
          loading: false,
          error: null,
          activeAgentId: "beta",
          filter: "",
        },
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
          activePanel: "channels",
          channels: {
            ...createProps().channels,
            snapshot: null,
            loading: false,
            error: null,
            lastSuccess: null,
          },
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
      const sectionDescs = Array.from(container.querySelectorAll(".settings-section__desc"));
      const lastRefresh = chinese
        .get("agents.channels.lastRefresh")
        ?.replace("{time}", chinese.get("common.never") ?? "");
      expect(sectionDescs.map((desc) => desc.textContent?.replace(/\s+/gu, " ").trim())).toContain(
        `${chinese.get("agents.channels.subtitle")} ${lastRefresh}`,
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
        snapshot: {
          ts: Date.now(),
          channelOrder: ["discord"],
          channelLabels: { discord: "Discord" },
          channels: {},
          channelAccounts: { discord: accounts },
          channelDefaultAccountId: { discord: "default" },
        },
        loading: false,
        error: null,
        lastSuccess: Date.now(),
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
  it("keeps standalone agent creation available with no agents", () => {
    const container = document.createElement("div");
    const onCreateAgent = vi.fn();
    renderView(
      {
        agentsList: {
          defaultId: "alpha",
          mainKey: "main",
          scope: "per-sender",
          agents: [],
        },
        selectedAgentId: "alpha",
        onCreateAgent,
      },
      container,
    );

    expect(container.querySelector("openclaw-agent-select")).toBeNull();
    const createButton = container.querySelector<HTMLButtonElement>(".agents-create-btn");
    expect(createButton?.textContent?.trim()).toBe(t("custodian.newAgent"));
    createButton?.click();
    expect(onCreateAgent).toHaveBeenCalledOnce();
  });

  it("preserves creation permission gating with multiple agents", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onCreateAgent = vi.fn();
    const defaults = createProps();
    try {
      renderView(
        {
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "alpha" }, { id: "beta" }],
          },
          access: { ...defaults.access, canCreateAgent: false },
          onCreateAgent,
        },
        container,
      );
      expect(container.querySelector("openclaw-agent-select")).toBeNull();
      expect(container.querySelector(".agents-create-btn")).toBeNull();
      expect(onCreateAgent).not.toHaveBeenCalled();
    } finally {
      container.remove();
    }
  });
});

it("surfaces agent config save errors in the active panel", () => {
  const container = document.createElement("div");
  renderView(
    {
      config: {
        configForm: { agents: { entries: { beta: {} } } },
        configSnapshot: null,
        configLoading: false,
        configSaving: false,
        configFormDirty: true,
        lastError: "mock validation failure",
      },
    },
    container,
  );

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("mock validation failure");
});

it.each([
  { name: "paused authorized job", enabled: false, canRunCron: true, canRun: true },
  { name: "enabled unauthorized job", enabled: true, canRunCron: false, canRun: false },
])("preserves edit links and gates Run Now for a $name", ({ enabled, canRunCron, canRun }) => {
  const container = document.createElement("div");
  const onCronRunNow = vi.fn();
  const job: CronJob = {
    id: "job /?&",
    name: "Weekly report",
    agentId: "alpha",
    enabled,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Summarize notes." },
    state: {},
  };
  const props = createProps({
    activePanel: "cron",
    selectedAgentId: "alpha",
    basePath: "/gateway",
  });
  renderView(
    {
      ...props,
      access: { ...props.access, canRunCron },
      cron: { ...props.cron, jobs: [job], onRunNow: onCronRunNow },
    },
    container,
  );
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
});
