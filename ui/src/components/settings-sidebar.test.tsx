/* @vitest-environment jsdom */

import { createSignal, type Setter } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentityResult } from "../api/types.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import { i18n, t } from "../i18n/index.ts";
import { pt_BR } from "../i18n/locales/pt-BR.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { AgentSelectElement } from "./agent-select.tsx";
import { saveIndicatorProps as saveIndicator } from "./settings-save-indicator.test-support.ts";
import { renderSettingsSidebar as SettingsSidebar } from "./settings-sidebar.tsx";
import "./tooltip.ts";

let container: HTMLDivElement;
type SidebarProps = Parameters<typeof SettingsSidebar>[0];
let updateSidebar: Setter<SidebarProps> | undefined;

function sidebarProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
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
    saveIndicator: saveIndicator(),
    ...overrides,
  };
}

function render(overrides: Partial<SidebarProps> = {}): void {
  const props = sidebarProps(overrides);
  if (!updateSidebar) {
    const [value, setValue] = createSignal(props);
    updateSidebar = setValue;
    mountSolid(() => <SettingsSidebar {...value()} />, { container });
  } else {
    updateSidebar(props);
  }
  flush();
}

function labels(selector = ".settings-sidebar__item-label") {
  return [...container.querySelectorAll(selector)].map((item) => item.textContent?.trim());
}

function searchHarness(initialQuery: string, overrides: Partial<SidebarProps> = {}) {
  let searchQuery = initialQuery;
  const rerender = () =>
    render({
      ...overrides,
      searchQuery,
      onSearchQueryChange: (next) => {
        searchQuery = next;
        rerender();
      },
    });
  rerender();
  const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input")!;
  return {
    input,
    get value() {
      return searchQuery;
    },
    enter: (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
  };
}

type SearchBlock = NonNullable<SidebarProps["searchBlockMatches"]>[number];
function block(
  routeId: SearchBlock["routeId"],
  label: string,
  hash: string,
  options: Partial<Pick<SearchBlock, "search" | "pathname">> = {},
): SearchBlock {
  return { routeId, label, hash, ...options };
}

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
    render({
      presentation: "embed-page",
      saveIndicator: { ...saveIndicator(), status: "error", lastError: "Save failed", onRetry },
    });
    expect(container.querySelector<HTMLElement>(".settings-sidebar")).toBeNull();
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
    render({
      activeRouteId: "model-setup",
    });

    const active = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/settings/model-providers"]',
    );
    expect(active?.classList.contains("settings-sidebar__item--active")).toBe(true);
    expect(active?.getAttribute("aria-current")).toBe("page");
    expect(active?.textContent?.trim()).toBe("Models");
  });

  it.each(["OpenClaw", "Moonbase"])(
    "links Ask %s and follows branding publications",
    (brandName) => {
      const original = currentThemeBranding();
      const onNavigate = vi.fn();
      render({ onNavigate });
      try {
        if (brandName === "Moonbase") {
          setCurrentThemeBranding({ ...original, brandName });
          flush();
        }
        const link = container.querySelector<HTMLAnchorElement>(
          '.settings-sidebar__item[href="/custodian"]',
        );
        expect(link?.textContent?.trim()).toBe(`Ask ${brandName}`);
        link?.click();
        expect(onNavigate).toHaveBeenCalledWith("custodian");
      } finally {
        setCurrentThemeBranding(original);
        flush();
      }
    },
  );

  it("does not match the middle of a word for a short query", () => {
    render({
      searchQuery: "cp",
      searchBlockMatches: [block("connection", "Gateway Host", "#settings-connection-host")],
    });

    const resultLabels = labels(".settings-sidebar__item-label, .settings-sidebar__subitem-label");
    expect(resultLabels).toEqual(["Gateway", "Gateway Host"]);
  });

  it("ranks matching pages before matching blocks and navigates to the block", () => {
    const onNavigate = vi.fn();
    render({
      searchQuery: "mcp",
      searchBlockMatches: [
        block("appearance", "Language", "#settings-language", {
          search: "?section=__appearance__",
        }),
        block("mcp", "MCP", "#config-section-mcp", { search: "?section=mcp" }),
      ],
      onNavigate,
    });

    const resultLabels = labels(".settings-sidebar__item-label, .settings-sidebar__subitem-label");
    expect(resultLabels).toEqual(["MCP", "Appearance", "Language"]);
    const active = container.querySelector<HTMLElement>(".settings-sidebar__item--active");
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
    render({
      searchQuery: "infrastructure",
      searchBlockMatches: [
        block("infrastructure", "Browser", "#config-section-browser", {
          search: "?section=browser",
        }),
      ],
      onNavigate,
    });

    const resultLabels = labels(".settings-sidebar__item-label, .settings-sidebar__subitem-label");
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
    render({
      activeRouteId: "agents",
      searchQuery: "agent defaults",
    });

    const result = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/settings/ai-agents"]',
    );
    expect(result?.textContent?.trim()).toBe("Agent Defaults");
  });

  it("excludes admin-only pages and config blocks from non-admin search", () => {
    render({
      canAdmin: false,
      searchQuery: "security",
      searchBlockMatches: [block("security", "Security policy", "#config-section-security")],
    });

    expect(container.querySelector<HTMLElement>('a[href="/settings/security"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('a[href$="#config-section-security"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('a[href="/settings/approvals"]')).not.toBeNull();
  });

  it("keeps Memory search results on the canonical Settings tab path", () => {
    const onNavigate = vi.fn();
    render({
      basePath: "/ui",
      activeRouteId: "memory",
      activePathname: "/ui/settings/memory/settings",
      activeHash: "#memory-backend",
      searchQuery: "backend",
      searchBlockMatches: [
        block("memory", "Memory", "#memory-backend", { pathname: "/ui/settings/memory/settings" }),
      ],
      onNavigate,
    });

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
    const onNavigate = vi.fn();
    const { input, enter: enterQuery } = searchHarness("", { onNavigate });
    const allLabels = labels();
    expect(input).toMatchObject({ ariaLabel: "Search settings", placeholder: "Search settings…" });
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
    expect(container.querySelector<HTMLElement>('[role="status"]')?.textContent?.trim()).toBe(
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
    const onExit = vi.fn();
    const search = searchHarness("gateway", { onExit });
    const { input } = search;
    expect(input).not.toBeNull();
    input?.focus();

    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(onExit).not.toHaveBeenCalled();

    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("renders refreshed settings route titles from the active locale", async () => {
    render({});

    i18n.registerTranslation("pt-BR", {
      routeTitles: {
        notifications: "Notificacoes",
        modelProviders: "Provedores de modelos",
        advanced: "Avancado",
      },
    });
    await i18n.setLocale("pt-BR");

    flush();

    expect(labels()).toEqual(
      expect.arrayContaining(["Notificacoes", "Provedores de modelos", "Avancado"]),
    );
  });

  it.each(["sidebar", "embed-list", "embed-page"] as const)(
    "preserves actionable save feedback in web settings and native connection recovery in %s",
    async (presentation) => {
      const onRetryConnect = vi.fn();
      const renderSidebar = (
        connectionStatus: Parameters<typeof SettingsSidebar>[0]["connectionStatus"],
        lastError: string | null = null,
      ) =>
        render({
          presentation,
          connectionStatus,
          footerStatus:
            presentation === "sidebar" && connectionStatus
              ? { kind: connectionStatus, lastError, queuedCount: 2, onRetry: onRetryConnect }
              : null,
          lastError,
          gatewayVersion: "1.0.0",
          onRetryConnect,
          saveIndicator: { ...saveIndicator(), status: "error", lastError: "Save failed" },
        });

      renderSidebar(null);
      expect(container.querySelector<HTMLElement>(".gateway-status__outbox")).toBeNull();
      await vi.waitFor(() => {
        expect(
          container.querySelector<HTMLElement>(".settings-save-indicator")?.textContent,
        ).toContain(t("configView.autoSaveFailed"));
      });

      renderSidebar(null);
      expect(container.querySelector<HTMLElement>(".gateway-status")).toBeNull();
      expect(
        container.querySelector<HTMLElement>("openclaw-settings-save-indicator"),
      ).not.toBeNull();

      for (const kind of [
        "connecting",
        "starting",
        "restarting",
        "suspending",
        "reconnecting",
        "restoring",
      ] as const) {
        renderSidebar(kind);
        expect(
          container.querySelector(".gateway-status__icon .session-run-spinner"),
        ).not.toBeNull();
        expect(container.querySelector(".gateway-status__retry")).toBeNull();
      }
      renderSidebar("reload-required");
      expect(container.querySelector(".gateway-status__icon .session-run-spinner")).toBeNull();

      renderSidebar("suspended", "connection refused?token=settings-secret");
      const suspended = container.querySelector<HTMLElement>(".gateway-status--suspended");
      expect(suspended?.textContent).toContain(t("connection.suspended"));
      expect(suspended?.textContent).not.toContain("in outbox");
      expect(container.querySelector<HTMLElement>(".gateway-status__retry")).toBeNull();
      expect(
        container.querySelector<HTMLElement>("openclaw-settings-save-indicator") !== null,
      ).toBe(presentation === "sidebar");
      if (presentation === "sidebar") {
        expect(
          container.querySelector<HTMLElement>(".sidebar-shell__footer")?.textContent,
        ).toContain("2 queued");
        expect(suspended?.hasAttribute("role")).toBe(false);
        expect(
          container.querySelector<HTMLElement>(".settings-save-indicator")?.textContent,
        ).toContain(t("configView.autoSaveFailed"));
      }

      renderSidebar("offline", "connection refused?token=settings-secret");
      expect(
        container.querySelector<HTMLElement>("openclaw-settings-save-indicator") !== null,
      ).toBe(presentation === "sidebar");
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
      const restarting = container.querySelector<HTMLElement>(".gateway-status--restarting");
      expect(restarting?.textContent).toContain(t("connection.restarting"));
      expect(restarting?.textContent).not.toContain("in outbox");
      expect(container.querySelector<HTMLElement>(".gateway-status__retry")).toBeNull();
    },
  );
});

describe("Settings agent selector", () => {
  const renderSidebar = (overrides: Partial<SidebarProps> = {}) => {
    const props = sidebarProps({ activeRouteId: "model-providers", ...overrides });
    render(props);
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
      render({
        ...props,
        settingsAgentSelection: {
          ...props.settingsAgentSelection,
          state: { selectedId: "research", scopeId: "research" },
        },
      });
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
  const props = sidebarProps();
  render(props);
  const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input")!;
  input.focus();
  input.value = "composing search";
  render({ ...props, connectionStatus: "reconnecting" });
  expect(container.querySelector<HTMLElement>(".settings-sidebar__search-input")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("composing search");
  const link = container.querySelector<HTMLAnchorElement>(".settings-sidebar__item")!;
  link.focus();
  render({ ...props, connectionStatus: "offline" });
  expect(container.querySelector<HTMLElement>(".settings-sidebar__item")).toBe(link);
  expect(document.activeElement).toBe(link);
  render({ ...props, searchQuery: "gateway" });
  expect(input.value).toBe("gateway");
  const other = mountSolid(() => <SettingsSidebar {...props} />);
  flush();
  const nav = container.querySelector<HTMLElement>(".settings-sidebar__nav")!;
  const search = container.querySelector<HTMLElement>(".settings-sidebar__search")!;
  const otherSearch = other.container.querySelector<HTMLElement>(".settings-sidebar__search")!;
  nav.scrollTop = 12;
  nav.dispatchEvent(new Event("scroll"));
  expect(search.classList.contains("settings-sidebar__search--scrolled")).toBe(true);
  expect(otherSearch.classList.contains("settings-sidebar__search--scrolled")).toBe(false);
  nav.scrollTop = 0;
  nav.dispatchEvent(new Event("scroll"));
  expect(search.classList.contains("settings-sidebar__search--scrolled")).toBe(false);
  other.unmount();
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
        return () => void selectionListeners.delete(listener);
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
        return () => void identityListeners.delete(listener);
      },
    };
    return {
      settingsAgentSelection,
      agentIdentity,
      selectionListeners,
      identityListeners,
      publishIdentity(emoji: string) {
        identities = [{ agentId: settingsAgentSelection.state.selectedId, emoji }];
        identityListeners.forEach((notify) => notify());
      },
    };
  };
  const original = createOwners();
  const props = sidebarProps({
    ...agents,
    ...original,
  });
  render(props);
  const selector = container.querySelector<AgentSelectElement>("openclaw-agent-select")!;
  await selector.updateComplete;
  const label = () => selector.querySelector(".agent-select__trigger")?.getAttribute("aria-label");
  const avatar = () =>
    selector
      .querySelector(".agent-select__trigger .identity-avatar__text")
      ?.getAttribute("data-avatar");
  const { settingsAgentSelection, selectionListeners, identityListeners } = original;
  const selectionSubscriptions = [...selectionListeners];
  const identitySubscriptions = [...identityListeners];
  const subscriptions = [selectionSubscriptions, identitySubscriptions];
  const optionCopy = selector.querySelector(".agent-select__option-copy");
  expect(optionCopy).not.toBeNull();
  render({ ...props, gatewayVersion: "test" });
  await selector.updateComplete;
  expect(selector.querySelector(".agent-select__option-copy")).toBe(optionCopy);
  expect([[...selectionListeners], [...identityListeners]]).toEqual(subscriptions);
  settingsAgentSelection.state.selectedId = "research";
  settingsAgentSelection.state.scopeId = "research";
  selectionListeners.forEach((notify) => notify(settingsAgentSelection.state));
  await waitForSolid(() => expect(label()).toContain("Research"));
  original.publishIdentity("🦉");
  await waitForSolid(() => expect(avatar()).toBe("🦉"));
  const replacement = createOwners();
  render({ ...props, ...replacement });
  await waitForSolid(() => expect(label()).toContain("Main"));
  expect(selectionListeners.size).toBe(0);
  expect(identityListeners.size).toBe(0);
  expect(replacement.agentIdentity.ensure).toHaveBeenCalledWith(["main"]);
  const originalRequests = original.agentIdentity.ensure.mock.calls.length;
  const replacementRequests = replacement.agentIdentity.ensure.mock.calls.length;
  settingsAgentSelection.state.selectedId = "main";
  settingsAgentSelection.state.scopeId = "main";
  selectionSubscriptions.forEach((notify) => notify(settingsAgentSelection.state));
  identitySubscriptions.forEach((notify) => notify());
  await waitForSolid(() => {
    expect(original.agentIdentity.ensure).toHaveBeenCalledTimes(originalRequests);
    expect(replacement.agentIdentity.ensure).toHaveBeenCalledTimes(replacementRequests);
    expect(label()).toContain("Main");
  });
  replacement.settingsAgentSelection.state.selectedId = "research";
  replacement.selectionListeners.forEach((notify) =>
    notify(replacement.settingsAgentSelection.state),
  );
  replacement.publishIdentity("🦊");
  await waitForSolid(() => {
    expect(replacement.agentIdentity.ensure).toHaveBeenLastCalledWith(["research"]);
    expect(avatar()).toBe("🦊");
  });
  render({
    ...props,
    ...replacement,
    agents: props.agents.map((agent) =>
      agent.id === "research" ? Object.assign({}, agent, { name: "Research renamed" }) : agent,
    ),
  });
  await waitForSolid(() => expect(label()).toContain("Research renamed"));
  expect(container.querySelector<HTMLElement>("openclaw-agent-select")).toBe(selector);
});
