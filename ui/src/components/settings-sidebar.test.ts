/* @vitest-environment jsdom */

import { render, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import { pt_BR } from "../i18n/locales/pt-BR.ts";
import type { AgentSelect } from "./agent-select.ts";
import { renderLazySettingsSidebar } from "./settings-sidebar-lazy.ts";
import { renderSettingsSidebar } from "./settings-sidebar.ts";
import "./tooltip.ts";

let container: HTMLDivElement;

const saveIndicator = () => ({
  status: "idle" as const,
  lastError: null,
  needsApply: false,
  applying: false,
  applyDisabled: false,
  onRetry: vi.fn(),
  onSave: vi.fn(),
  onReload: vi.fn(),
  onApply: vi.fn(),
});

const sidebarAgentProps = () => ({
  agents: [
    { id: "main", name: "Main" },
    { id: "research", name: "Research" },
  ],
  agentIdentity: {
    get: () => null,
    entries: () => [],
    ensure: async () => {},
    invalidate: () => {},
    subscribe: () => () => {},
  },
  settingsAgentSelection: {
    state: { selectedId: "main", scopeId: "main" },
    intentRevision: 0,
    set: vi.fn(),
    setScope: vi.fn(),
    subscribe: () => () => {},
  },
});

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
  container.remove();
});

describe("settings sidebar search", () => {
  it.each([undefined, "host"] as const)(
    "keeps embedded save recovery with %s navigation chrome",
    async (navigationChrome) => {
      const onRetry = vi.fn();
      render(
        renderSettingsSidebar({
          ...sidebarAgentProps(),
          presentation: "embed-page",
          navigationChrome,
          basePath: "",
          activeRouteId: "appearance",
          connectionStatus: null,
          lastError: null,
          gatewayVersion: "",
          searchQuery: "",
          onExit: vi.fn(),
          onRetryConnect: vi.fn(),
          onNavigate: vi.fn(),
          onSearchQueryChange: vi.fn(),
          preloadTimers: new Map(),
          saveIndicator: { ...saveIndicator(), status: "error", lastError: "Save failed", onRetry },
        }),
        container,
      );
      expect(container.querySelector(".settings-sidebar")).toBeNull();
      expect(container.querySelector(".native-embed-header__back") !== null).toBe(
        navigationChrome !== "host",
      );
      expect(container.querySelector("h1") !== null).toBe(navigationChrome !== "host");
      await container.querySelector<LitElement>("openclaw-settings-save-indicator")!.updateComplete;
      const retry = container.querySelector<HTMLButtonElement>(".settings-save-indicator__action");
      expect(retry?.textContent?.trim()).toBe("Retry");
      container.querySelector<HTMLButtonElement>(".settings-save-indicator__action")!.click();
      expect(onRetry).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "keeps host-owned navigation out of the lazy header (failed=%s)",
    (failed) => {
      const retry = vi.fn();
      render(
        renderLazySettingsSidebar(
          {
            settingsSidebarRenderer: null,
            settingsSidebarLoadFailed: failed,
            loadSettingsSidebarRenderer: vi.fn(),
            retrySettingsSidebarRenderer: retry,
          },
          {
            ...sidebarAgentProps(),
            presentation: "embed-page",
            navigationChrome: "host",
            basePath: "",
            activeRouteId: "cron",
            connectionStatus: null,
            lastError: null,
            gatewayVersion: "",
            searchQuery: "",
            onExit: vi.fn(),
            onRetryConnect: vi.fn(),
            onNavigate: vi.fn(),
            onSearchQueryChange: vi.fn(),
            preloadTimers: new Map(),
            saveIndicator: saveIndicator(),
          },
        ),
        container,
      );
      expect(container.querySelector(".native-embed-header__back, h1")).toBeNull();
      expect(container.querySelector(failed ? '[role="alert"]' : '[role="status"]')).not.toBeNull();
      if (failed) {
        container.querySelector<HTMLButtonElement>("button")!.click();
        expect(retry).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps Models selected while its setup flow is open", () => {
    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "",
        activeRouteId: "model-setup",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        searchQuery: "",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const active = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/settings/model-providers"]',
    );
    expect(active?.classList.contains("settings-sidebar__item--active")).toBe(true);
    expect(active?.getAttribute("aria-current")).toBe("page");
    expect(active?.textContent?.trim()).toBe("Models");
  });

  it("links Ask OpenClaw to the shared custodian route", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "",
        activeRouteId: "appearance",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        searchQuery: "",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const link = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/custodian"]',
    );
    expect(link?.textContent?.trim()).toBe("Ask OpenClaw");
    link?.click();
    expect(onNavigate).toHaveBeenCalledWith("custodian");
  });

  it("does not match the middle of a word for a short query", () => {
    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "",
        activeRouteId: "appearance",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        searchQuery: "cp",
        searchBlockMatches: [
          {
            routeId: "connection",
            label: "Gateway Host",
            hash: "#settings-connection-host",
          },
        ],
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const resultLabels = [
      ...container.querySelectorAll(
        ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
      ),
    ].map((item) => item.textContent?.trim());
    expect(resultLabels).toEqual(["Gateway", "Gateway Host"]);
  });

  it("ranks matching pages before matching blocks and navigates to the block", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "",
        activeRouteId: "appearance",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        searchQuery: "mcp",
        searchBlockMatches: [
          {
            routeId: "appearance",
            label: "Language",
            search: "?section=__appearance__",
            hash: "#settings-language",
          },
          {
            routeId: "mcp",
            label: "MCP",
            search: "?section=mcp",
            hash: "#config-section-mcp",
          },
        ],
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const resultLabels = [
      ...container.querySelectorAll(
        ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
      ),
    ].map((item) => item.textContent?.trim());
    expect(resultLabels).toEqual(["MCP", "Appearance", "Language"]);
    const active = container.querySelector(".settings-sidebar__item--active");
    expect(active?.textContent).toContain("Appearance");
    expect(active?.getAttribute("aria-current")).toBe("page");

    const language = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__subitem[href="/settings/appearance?section=__appearance__#settings-language"]',
    );
    language?.click();
    expect(onNavigate).toHaveBeenCalledWith("appearance", {
      search: "?section=__appearance__",
      hash: "#settings-language",
    });
  });

  it("keeps a precise block result when its owning page also matches", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "",
        activeRouteId: "appearance",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        searchQuery: "infrastructure",
        searchBlockMatches: [
          {
            routeId: "infrastructure",
            label: "Browser",
            search: "?section=browser",
            hash: "#config-section-browser",
          },
        ],
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const resultLabels = [
      ...container.querySelectorAll(
        ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
      ),
    ].map((item) => item.textContent?.trim());
    expect(resultLabels).toEqual(["Infrastructure", "Browser"]);

    container
      .querySelector<HTMLAnchorElement>(
        '.settings-sidebar__subitem[href="/settings/infrastructure?section=browser#config-section-browser"]',
      )
      ?.click();
    expect(onNavigate).toHaveBeenCalledWith("infrastructure", {
      search: "?section=browser",
      hash: "#config-section-browser",
    });
  });

  it("finds Agent Defaults by page name after its sidebar demotion", () => {
    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "",
        activeRouteId: "agents",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        searchQuery: "agent defaults",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const result = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/settings/ai-agents"]',
    );
    expect(result?.textContent?.trim()).toBe("Agent Defaults");
  });

  it("excludes admin-only pages and config blocks from non-admin search", () => {
    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "",
        activeRouteId: "appearance",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        canAdmin: false,
        searchQuery: "security",
        searchBlockMatches: [
          {
            routeId: "security",
            label: "Security policy",
            hash: "#config-section-security",
          },
        ],
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    expect(container.querySelector('a[href="/settings/security"]')).toBeNull();
    expect(container.querySelector('a[href$="#config-section-security"]')).toBeNull();
    expect(container.querySelector('a[href="/settings/approvals"]')).not.toBeNull();
  });

  it("keeps Memory search results on the canonical Settings tab path", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "/ui",
        activeRouteId: "memory",
        activePathname: "/ui/settings/memory/settings",
        activeHash: "#memory-backend",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        searchQuery: "backend",
        searchBlockMatches: [
          {
            routeId: "memory",
            label: "Memory",
            pathname: "/ui/settings/memory/settings",
            hash: "#memory-backend",
          },
        ],
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const link = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__subitem[href="/ui/settings/memory/settings#memory-backend"]',
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute("aria-current")).toBe("location");
    link?.click();
    expect(onNavigate).toHaveBeenCalledWith("memory", {
      pathname: "/ui/settings/memory/settings",
      hash: "#memory-backend",
    });
  });

  it("filters localized routes and groups while preserving navigation", () => {
    let searchQuery = "";
    const onNavigate = vi.fn();
    const rerender = () => {
      render(
        renderSettingsSidebar({
          ...sidebarAgentProps(),
          basePath: "",
          activeRouteId: "appearance",
          connectionStatus: null,
          lastError: null,
          gatewayVersion: "",
          searchQuery,
          onExit: vi.fn(),
          onRetryConnect: vi.fn(),
          onNavigate,
          onSearchQueryChange: (nextQuery) => {
            searchQuery = nextQuery;
            rerender();
          },
          preloadTimers: new Map(),
          saveIndicator: saveIndicator(),
        }),
        container,
      );
    };
    const enterQuery = (query: string) => {
      const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input");
      if (!input) {
        throw new Error("expected settings search input");
      }
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const labels = () =>
      [...container.querySelectorAll(".settings-sidebar__item-label")].map((item) =>
        item.textContent?.trim(),
      );

    rerender();
    const allLabels = labels();
    const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input");
    expect(input?.getAttribute("aria-label")).toBe("Search settings");
    expect(input?.placeholder).toBe("Search settings…");
    // Management surfaces moved back to the workspace sidebar.
    expect(allLabels).not.toContain("Activity");
    expect(allLabels).not.toContain("Sessions");
    expect(allLabels).toContain("Privacy & Security");
    expect(allLabels.indexOf("Updates")).toBe(allLabels.indexOf("Logs") + 1);
    expect(allLabels.indexOf("About")).toBe(allLabels.indexOf("Updates") + 1);

    enterQuery("  ThEmE  ");
    expect(labels()).toEqual(["Appearance"]);

    enterQuery("connections");
    expect(labels()).toEqual([
      "Gateway",
      "Channels",
      "Communications",
      "Talk",
      "Devices",
      "Cloud workers",
    ]);

    enterQuery("does-not-exist");
    expect(labels()).toEqual([]);
    expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      "No matching settings.",
    );

    container.querySelector<HTMLButtonElement>(".settings-sidebar__search-clear")?.click();
    expect(labels()).toEqual(allLabels);
    expect(document.activeElement).toBe(input);

    enterQuery("channel");
    container
      .querySelector<HTMLAnchorElement>('.settings-sidebar__item[href="/settings/channels"]')
      ?.click();
    expect(onNavigate).toHaveBeenCalledWith("channels");
  });

  it("clears a focused search before Escape exits Settings", () => {
    let searchQuery = "gateway";
    const onExit = vi.fn();
    const rerender = () => {
      render(
        renderSettingsSidebar({
          ...sidebarAgentProps(),
          basePath: "",
          activeRouteId: "appearance",
          connectionStatus: null,
          lastError: null,
          gatewayVersion: "",
          searchQuery,
          onExit,
          onRetryConnect: vi.fn(),
          onNavigate: vi.fn(),
          onSearchQueryChange: (nextQuery) => {
            searchQuery = nextQuery;
            rerender();
          },
          preloadTimers: new Map(),
          saveIndicator: saveIndicator(),
        }),
        container,
      );
    };

    rerender();
    const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input");
    expect(input).not.toBeNull();
    input?.focus();

    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(searchQuery).toBe("");
    expect(document.activeElement).toBe(input);
    expect(onExit).not.toHaveBeenCalled();

    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("renders refreshed settings route titles from the active locale", async () => {
    i18n.registerTranslation("pt-BR", {
      routeTitles: {
        notifications: "Notificacoes",
        modelProviders: "Provedores de modelos",
        advanced: "Avancado",
      },
    });
    await i18n.setLocale("pt-BR");

    render(
      renderSettingsSidebar({
        ...sidebarAgentProps(),
        basePath: "",
        activeRouteId: "appearance",
        connectionStatus: null,
        lastError: null,
        gatewayVersion: "",
        searchQuery: "",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const labels = [...container.querySelectorAll(".settings-sidebar__item-label")].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toContain("Notificacoes");
    expect(labels).toContain("Provedores de modelos");
    expect(labels).toContain("Avancado");
  });

  it.each(["sidebar", "embed-list", "embed-page"] as const)(
    "keeps connection recovery separate from delivery in %s",
    async (presentation) => {
      const onRetryConnect = vi.fn();
      const renderSidebar = (
        connectionStatus: Parameters<typeof renderSettingsSidebar>[0]["connectionStatus"],
        lastError: string | null = null,
      ) =>
        render(
          renderSettingsSidebar({
            ...sidebarAgentProps(),
            presentation,
            basePath: "",
            activeRouteId: "appearance",
            connectionStatus,
            lastError,
            gatewayVersion: "1.0.0",
            searchQuery: "",
            onExit: vi.fn(),
            onRetryConnect,
            onNavigate: vi.fn(),
            onSearchQueryChange: vi.fn(),
            preloadTimers: new Map(),
            saveIndicator: { ...saveIndicator(), status: "saving" },
          }),
          container,
        );

      renderSidebar(null);
      expect(container.querySelector(".gateway-status__outbox")).toBeNull();
      await vi.waitFor(() => {
        expect(container.querySelector(".settings-save-indicator")?.textContent).toContain(
          t("configView.autoSaveSaving"),
        );
      });

      renderSidebar(null);
      expect(container.querySelector(".gateway-status")).toBeNull();
      expect(container.querySelector("openclaw-settings-save-indicator")).not.toBeNull();

      renderSidebar("suspended", "connection refused?token=settings-secret");
      const suspended = container.querySelector(".gateway-status--suspended");
      expect(suspended?.textContent).toContain(t("connection.suspended"));
      expect(suspended?.textContent).not.toContain("in outbox");
      expect(container.querySelector("button.gateway-status")).toBeNull();
      expect(container.querySelector("openclaw-settings-save-indicator")).toBeNull();

      renderSidebar("offline", "connection refused?token=settings-secret");
      expect(container.querySelector("openclaw-settings-save-indicator")).toBeNull();
      const button = container.querySelector<HTMLButtonElement>("button.gateway-status");
      expect(button?.hasAttribute("title")).toBe(false);
      expect(
        (button?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
          ?.content,
      ).toBe("connection refused?[redacted-credential]");
      expect(button?.textContent).not.toContain("in outbox");
      expect(button?.getAttribute("aria-label")).toBe("Disconnected — Retry now");
      button?.click();
      expect(onRetryConnect).toHaveBeenCalledOnce();

      renderSidebar("restarting");
      const restarting = container.querySelector(".gateway-status--restarting");
      expect(restarting?.textContent).toContain(t("connection.restarting"));
      expect(restarting?.textContent).not.toContain("in outbox");
      expect(container.querySelector("button.gateway-status")).toBeNull();
    },
  );
});

describe("Settings agent selector", () => {
  const renderSidebar = (overrides: Partial<Parameters<typeof renderSettingsSidebar>[0]> = {}) => {
    const props = {
      ...sidebarAgentProps(),
      basePath: "",
      activeRouteId: "model-providers" as const,
      connectionStatus: null,
      lastError: null,
      gatewayVersion: "",
      searchQuery: "",
      onExit: vi.fn(),
      onRetryConnect: vi.fn(),
      onNavigate: vi.fn(),
      onSearchQueryChange: vi.fn(),
      preloadTimers: new Map(),
      saveIndicator: saveIndicator(),
      ...overrides,
    };
    render(renderSettingsSidebar(props), container);
    return props;
  };

  it.each([
    { presentation: "sidebar" },
    { presentation: "embed-list" },
    { presentation: "embed-page" },
    { presentation: "embed-page", navigationChrome: "host" },
  ] as const)("uses the shared settings selection with %j", async (presentation) => {
    const props = renderSidebar(presentation);
    expect(container.querySelectorAll("openclaw-agent-select")).toHaveLength(1);
    const selector = container.querySelector<AgentSelect>("openclaw-agent-select")!;
    await selector.updateComplete;
    expect(selector.querySelector(".agent-select__trigger")?.getAttribute("aria-label")).toContain(
      "Main",
    );
    const research = selector.querySelector<HTMLElement>('[aria-label="Research"]')!;
    research.click();
    expect(props.settingsAgentSelection.set).toHaveBeenCalledWith("research");
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("leaves host-embedded Automations agent scope with its page owner", () => {
    renderSidebar({ presentation: "embed-page", navigationChrome: "host", activeRouteId: "cron" });
    expect(container.querySelector("openclaw-agent-select")).toBeNull();
    renderSidebar({ presentation: "embed-page", activeRouteId: "cron" });
    expect(container.querySelector("openclaw-agent-select")).not.toBeNull();
  });

  it.each([0, 1])(
    "keeps a disabled shared selector visible with %i selectable agents",
    async (count) => {
      renderSidebar({
        agents: [
          ...[{ id: "main", name: "Main" }].slice(0, count),
          { id: "system", name: "System", kind: "system" },
        ],
        settingsAgentSelection: {
          ...sidebarAgentProps().settingsAgentSelection,
          state: { selectedId: count ? "main" : null, scopeId: count ? "main" : null },
        },
      });
      const selector = container.querySelector<AgentSelect>("openclaw-agent-select")!;
      await selector.updateComplete;
      expect(selector.querySelector<HTMLButtonElement>(".agent-select__trigger")?.disabled).toBe(
        true,
      );
      expect(selector.querySelectorAll("[data-agent-option]")).toHaveLength(count);
      expect(selector.options.some((option) => option.value === "system")).toBe(false);
    },
  );

  it("preserves creator grouping without hiding dangling or cyclic agents", async () => {
    renderSidebar({
      agents: [
        { id: "main", name: "Main" },
        { id: "orphan", name: "Orphan", creatorAgentId: "deleted" },
        { id: "research", name: "Research", creatorAgentId: "main" },
        { id: "cycle-a", creatorAgentId: "cycle-b" },
        { id: "cycle-b", creatorAgentId: "cycle-a" },
        { id: "system", kind: "system" },
      ],
    });
    const selector = container.querySelector<AgentSelect>("openclaw-agent-select")!;
    await selector.updateComplete;
    expect(selector.options.map((option) => option.value)).toEqual([
      "main",
      "research",
      "orphan",
      "cycle-a",
      "cycle-b",
    ]);
    const rows = selector.querySelectorAll("[data-agent-option]");
    expect(rows[1]?.querySelector(".agent-select__option-description")?.textContent?.trim()).toBe(
      t("agents.createdBy", { id: "main" }),
    );
    expect(rows[2]?.querySelector(".agent-select__option-description")).toBeNull();
  });
});
