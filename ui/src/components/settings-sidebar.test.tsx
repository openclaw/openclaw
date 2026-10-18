/* @vitest-environment jsdom */

import { createSignal, type Setter } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentityResult } from "../api/types.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import { i18n, t } from "../i18n/index.ts";
import { pt_BR } from "../i18n/locales/pt-BR.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { AgentSelectElement } from "./agent-select.ts";
import { renderSettingsSidebar as SettingsSidebar } from "./settings-sidebar.tsx";
import "./tooltip.ts";

let container: HTMLDivElement;
type SidebarProps = Parameters<typeof SettingsSidebar>[0];
let updateSidebar: Setter<SidebarProps> | undefined;

function render(props: SidebarProps, target: HTMLDivElement): void {
  if (!updateSidebar) {
    const [value, setValue] = createSignal(props);
    updateSidebar = setValue;
    mountSolid(() => <SettingsSidebar {...value()} />, { container: target });
  } else {
    updateSidebar(props);
  }
  flush();
}

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
    ensure: vi.fn(async () => {}),
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
  updateSidebar = undefined;
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
  it("keeps save recovery available in the embedded page header", async () => {
    const onRetry = vi.fn();
    render(
      {
        ...sidebarAgentProps(),
        presentation: "embed-page",
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
      },
      container,
    );
    expect(container.querySelector(".settings-sidebar")).toBeNull();
    await vi.waitFor(() => {
      const retry = container.querySelector<HTMLButtonElement>(
        ".native-embed-header .settings-save-indicator__action",
      );
      expect(retry?.textContent?.trim()).toBe("Retry");
    });
    container.querySelector<HTMLButtonElement>(".settings-save-indicator__action")!.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps Models selected while its setup flow is open", () => {
    render(
      {
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
      },
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
      {
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
      },
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
      {
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
      },
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
      {
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
      },
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
      {
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
      },
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
      {
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
      },
      container,
    );

    const result = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/settings/ai-agents"]',
    );
    expect(result?.textContent?.trim()).toBe("Agent Defaults");
  });

  it("excludes admin-only pages and config blocks from non-admin search", () => {
    render(
      {
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
      },
      container,
    );

    expect(container.querySelector('a[href="/settings/security"]')).toBeNull();
    expect(container.querySelector('a[href$="#config-section-security"]')).toBeNull();
    expect(container.querySelector('a[href="/settings/approvals"]')).not.toBeNull();
  });

  it("keeps Memory search results on the canonical Settings tab path", () => {
    const onNavigate = vi.fn();
    render(
      {
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
      },
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
        {
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
        },
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
      "Cloud environments",
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
        {
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
        },
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
    render(
      {
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
      },
      container,
    );

    i18n.registerTranslation("pt-BR", {
      routeTitles: {
        notifications: "Notificacoes",
        modelProviders: "Provedores de modelos",
        advanced: "Avancado",
      },
    });
    await i18n.setLocale("pt-BR");

    flush();

    const labels = [...container.querySelectorAll(".settings-sidebar__item-label")].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toContain("Notificacoes");
    expect(labels).toContain("Provedores de modelos");
    expect(labels).toContain("Avancado");
  });

  it.each(["sidebar", "embed-list", "embed-page"] as const)(
    "preserves save feedback in web settings and native connection recovery in %s",
    async (presentation) => {
      const onRetryConnect = vi.fn();
      const renderSidebar = (
        connectionStatus: Parameters<typeof SettingsSidebar>[0]["connectionStatus"],
        lastError: string | null = null,
      ) =>
        render(
          {
            ...sidebarAgentProps(),
            presentation,
            basePath: "",
            activeRouteId: "appearance",
            connectionStatus,
            footerStatus:
              presentation === "sidebar" && connectionStatus
                ? { kind: connectionStatus, lastError, queuedCount: 2, onRetry: onRetryConnect }
                : null,
            lastError,
            gatewayVersion: "1.0.0",
            searchQuery: "",
            onExit: vi.fn(),
            onRetryConnect,
            onNavigate: vi.fn(),
            onSearchQueryChange: vi.fn(),
            preloadTimers: new Map(),
            saveIndicator: { ...saveIndicator(), status: "saving" },
          },
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
      expect(container.querySelector(".gateway-status__retry")).toBeNull();
      expect(container.querySelector("openclaw-settings-save-indicator") !== null).toBe(
        presentation === "sidebar",
      );
      if (presentation === "sidebar") {
        expect(container.querySelector(".sidebar-shell__footer")?.textContent).toContain(
          "2 queued",
        );
        expect(suspended?.hasAttribute("role")).toBe(false);
        expect(container.querySelector(".settings-save-indicator")?.textContent).toContain(
          t("configView.autoSaveSaving"),
        );
      }

      renderSidebar("offline", "connection refused?token=settings-secret");
      expect(container.querySelector("openclaw-settings-save-indicator") !== null).toBe(
        presentation === "sidebar",
      );
      const button = container.querySelector<HTMLButtonElement>(".gateway-status__retry");
      expect(button?.hasAttribute("title")).toBe(false);
      expect(
        (button?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
          ?.content,
      ).toBe("connection refused?[redacted-credential]");
      expect(button?.textContent).not.toContain("in outbox");
      expect(button?.getAttribute("aria-label")).toBe(
        presentation === "sidebar"
          ? "Disconnected · 2 queued — Retry now"
          : "Disconnected — Retry now",
      );
      button?.click();
      expect(onRetryConnect).toHaveBeenCalledOnce();

      renderSidebar("restarting");
      const restarting = container.querySelector(".gateway-status--restarting");
      expect(restarting?.textContent).toContain(t("connection.restarting"));
      expect(restarting?.textContent).not.toContain("in outbox");
      expect(container.querySelector(".gateway-status__retry")).toBeNull();
    },
  );
});

describe("Settings agent selector", () => {
  const renderSidebar = (overrides: Partial<Parameters<typeof SettingsSidebar>[0]> = {}) => {
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
    render(props, container);
    return props;
  };

  it.each(["sidebar", "embed-list", "embed-page"] as const)(
    "uses the shared selection in the %s presentation",
    async (presentation) => {
      const props = renderSidebar({ presentation });
      expect(container.querySelectorAll("openclaw-agent-select")).toHaveLength(1);
      const selector = container.querySelector<AgentSelectElement>("openclaw-agent-select")!;
      await selector.updateComplete;
      expect(props.agentIdentity.ensure).toHaveBeenCalledWith(["main"]);
      expect(
        selector.querySelector(".agent-select__trigger")?.getAttribute("aria-label"),
      ).toContain("Main");
      for (const item of selector.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
        item.scrollIntoView = vi.fn();
      }
      const trigger = selector.querySelector<HTMLButtonElement>(".agent-select__trigger")!;
      trigger.click();
      await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      expect(props.agentIdentity.ensure).toHaveBeenCalledWith(["main", "research"]);
      const research = selector.querySelector<HTMLElement>('[aria-label="Research"]')!;
      research.click();
      await waitForSolid(() =>
        expect(props.settingsAgentSelection.set).toHaveBeenCalledWith("research"),
      );
      expect(props.onNavigate).not.toHaveBeenCalled();
      render(
        {
          ...props,
          settingsAgentSelection: {
            ...props.settingsAgentSelection,
            state: { selectedId: "research", scopeId: "research" },
          },
        },
        container,
      );
      await waitForSolid(() =>
        expect(props.agentIdentity.ensure).toHaveBeenLastCalledWith(["research"]),
      );
    },
  );

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
      const selector = container.querySelector<AgentSelectElement>("openclaw-agent-select")!;
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
    const selector = container.querySelector<AgentSelectElement>("openclaw-agent-select")!;
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

it("preserves search drafts, navigation focus, and instance-local scroll shadows", () => {
  const props: SidebarProps = {
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
  };
  render(props, container);
  const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input")!;
  input.focus();
  input.value = "composing search";
  render({ ...props, connectionStatus: "reconnecting" }, container);
  expect(container.querySelector(".settings-sidebar__search-input")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("composing search");
  const link = container.querySelector<HTMLAnchorElement>(".settings-sidebar__item")!;
  link.focus();
  render({ ...props, connectionStatus: "offline" }, container);
  expect(container.querySelector(".settings-sidebar__item")).toBe(link);
  expect(document.activeElement).toBe(link);
  render({ ...props, searchQuery: "gateway" }, container);
  expect(input.value).toBe("gateway");
  const other = mountSolid(() => <SettingsSidebar {...props} />);
  flush();
  const nav = container.querySelector<HTMLElement>(".settings-sidebar__nav")!;
  const search = container.querySelector(".settings-sidebar__search")!;
  const otherSearch = other.container.querySelector(".settings-sidebar__search")!;
  nav.scrollTop = 12;
  nav.dispatchEvent(new Event("scroll"));
  expect(search.classList.contains("settings-sidebar__search--scrolled")).toBe(true);
  expect(otherSearch.classList.contains("settings-sidebar__search--scrolled")).toBe(false);
  nav.scrollTop = 0;
  nav.dispatchEvent(new Event("scroll"));
  expect(search.classList.contains("settings-sidebar__search--scrolled")).toBe(false);
  other.unmount();
});

it("refreshes the Ask label when the branding owner publishes", () => {
  const original = currentThemeBranding();
  render(
    {
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
    },
    container,
  );
  try {
    setCurrentThemeBranding({ ...original, brandName: "Moonbase" });
    flush();
    expect(
      container.querySelector('.settings-sidebar__item[href="/custodian"]')?.textContent?.trim(),
    ).toBe("Ask Moonbase");
  } finally {
    setCurrentThemeBranding(original);
    flush();
  }
});

it("follows agent owner replacement and publications without remounting", async () => {
  const agents = sidebarAgentProps();
  type SelectionListener = Parameters<SidebarProps["settingsAgentSelection"]["subscribe"]>[0];
  const createOwners = () => {
    const selectionListeners = new Set<SelectionListener>();
    const identityListeners = new Set<() => void>();
    let identities: AgentIdentityResult[] = [];
    const settingsAgentSelection = {
      ...agents.settingsAgentSelection,
      state: { selectedId: "main", scopeId: "main" },
      subscribe(listener: SelectionListener) {
        selectionListeners.add(listener);
        return () => {
          selectionListeners.delete(listener);
        };
      },
    };
    const agentIdentity = {
      ...agents.agentIdentity,
      ensure: vi.fn(async () => {}),
      get: (agentId: string | null | undefined) =>
        identities.find((identity) => identity.agentId === agentId) ?? null,
      entries: () => identities,
      subscribe(listener: () => void) {
        identityListeners.add(listener);
        return () => {
          identityListeners.delete(listener);
        };
      },
    };
    return {
      settingsAgentSelection,
      agentIdentity,
      selectionListeners,
      identityListeners,
      publishIdentity(emoji: string) {
        identities = [{ agentId: settingsAgentSelection.state.selectedId, emoji }];
        for (const notify of identityListeners) {
          notify();
        }
      },
    };
  };
  const original = createOwners();
  const props: SidebarProps = {
    ...agents,
    ...original,
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
  };
  render(props, container);
  const selector = container.querySelector<AgentSelectElement>("openclaw-agent-select")!;
  await selector.updateComplete;
  const { settingsAgentSelection, selectionListeners, identityListeners } = original;
  const subscriptions = [[...selectionListeners], [...identityListeners]];
  render({ ...props, gatewayVersion: "test" }, container);
  expect([[...selectionListeners], [...identityListeners]]).toEqual(subscriptions);
  settingsAgentSelection.state.selectedId = "research";
  settingsAgentSelection.state.scopeId = "research";
  for (const notify of selectionListeners) {
    notify(settingsAgentSelection.state);
  }
  await waitForSolid(() =>
    expect(selector.querySelector(".agent-select__trigger")?.getAttribute("aria-label")).toContain(
      "Research",
    ),
  );
  original.publishIdentity("🦉");
  await waitForSolid(() =>
    expect(
      selector
        .querySelector(".agent-select__trigger .identity-avatar__text")
        ?.getAttribute("data-avatar"),
    ).toBe("🦉"),
  );
  const replacement = createOwners();
  render({ ...props, ...replacement }, container);
  await waitForSolid(() =>
    expect(selector.querySelector(".agent-select__trigger")?.getAttribute("aria-label")).toContain(
      "Main",
    ),
  );
  expect(selectionListeners.size).toBe(0);
  expect(identityListeners.size).toBe(0);
  expect(replacement.agentIdentity.ensure).toHaveBeenCalledWith(["main"]);
  replacement.settingsAgentSelection.state.selectedId = "research";
  for (const notify of replacement.selectionListeners) {
    notify(replacement.settingsAgentSelection.state);
  }
  replacement.publishIdentity("🦊");
  await waitForSolid(() => {
    expect(replacement.agentIdentity.ensure).toHaveBeenLastCalledWith(["research"]);
    expect(
      selector
        .querySelector(".agent-select__trigger .identity-avatar__text")
        ?.getAttribute("data-avatar"),
    ).toBe("🦊");
  });
  expect(container.querySelector("openclaw-agent-select")).toBe(selector);
});
