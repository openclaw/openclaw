/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import { loadModelCatalog } from "../lib/model-catalog-store.ts";
import {
  openPalette,
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  expectPalettePromptMode,
  findPaletteOption,
  mountPalette,
  mountSearch,
  searchPalette,
  registerCommandPaletteTestHooks,
  settlePalette,
  paletteInput,
  setInputValue,
  pressKey,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
} from "./panel-toggle-contract.ts";

const modelGateway = (request: (method: string, params: unknown) => unknown) =>
  createGateway(true, {
    methods: ["models.list"],
    request: (method, params) =>
      method === "models.list" ? request(method, params) : { results: [], sessions: [] },
  });

const modelResult = (id: string, name: string) => ({
  models: [{ provider: "fixture", id, name }],
});

function agentContext(
  context: ApplicationContext,
  agents: { id: string; name: string; model?: { primary: string } }[],
  defaultId = "main",
) {
  return {
    ...context,
    agents: {
      ...context.agents,
      ensureList: async () => ({
        defaultId,
        mainKey: "main",
        scope: "per-sender" as const,
        agents,
      }),
    },
  };
}

describe("CommandPalette search", () => {
  registerCommandPaletteTestHooks();

  it("lazily searches compact automation names once per connection", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        return { models: [] };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "nightly-invoices", name: "Nightly invoices" }] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const empty = { ...createSessionResult("agent:main:none", "None"), sessions: [] };
    const { palette, emit, setConnected } = await mountSearch(
      { methods: ["cron.list"], request },
      vi.fn(async () => empty),
    );

    await searchPalette(palette, "nightly");
    await vi.waitFor(() => expect(palette.textContent).toContain("Nightly invoices"));
    const item = findPaletteOption(palette, "Nightly invoices");
    item?.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("cron");

    await vi.advanceTimersByTimeAsync(60_000);
    await searchPalette(palette, "invoices");
    await vi.waitFor(() => expect(palette.textContent).toContain("Nightly invoices"));
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(1);

    emit("cron");
    await vi.advanceTimersByTimeAsync(200);
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(2);
    setConnected(false);
    setConnected(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(3);
  });

  it("shows model results while another catalog is still pending", async () => {
    const automations = createDeferred<{ jobs: { id: string; name: string }[] }>();
    const { palette } = await mountSearch({
      methods: ["cron.list", "models.list"],
      request: vi.fn(async (method: string) => {
        if (method === "cron.list") {
          return automations.promise;
        }
        if (method === "models.list") {
          return modelResult("needle", "Needle model");
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    });

    await searchPalette(palette, "needle");
    await vi.waitFor(() => expect(findPaletteOption(palette, "Needle model")).toBeDefined());
    expect(palette.textContent).toContain("Searching commands");
    findPaletteOption(palette, "Needle model")?.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("model-providers");

    await searchPalette(palette, "needle");
    automations.resolve({ jobs: [{ id: "needle-job", name: "Needle automation" }] });
    await vi.waitFor(() => expect(findPaletteOption(palette, "Needle automation")).toBeDefined());
    expect(findPaletteOption(palette, "Needle model")).toBeDefined();
    expect(palette.textContent).not.toContain("Searching commands");
  });

  it("clears a failed model search when another view publishes the catalog", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce(modelResult("needle", "Needle"));
    const { gateway } = modelGateway(request);
    const { palette, query } = await mountPalette(createContext(gateway, async () => null));
    await searchPalette(palette, "needle");
    await vi.waitFor(() =>
      expect(query(".cmd-palette__source-error")?.textContent).toContain(
        "Model search unavailable",
      ),
    );

    await loadModelCatalog(gateway.snapshot.client!, { agentId: "main" });
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle")).toBeDefined();
    expect(query(".cmd-palette__source-error")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("excludes agent primary models when selection is restricted", async () => {
    const { gateway } = createGateway(true, {
      methods: ["models.list"],
      request: vi.fn(async () => ({
        models: [],
        modelSelectionPolicy: { restricted: true },
      })),
    });
    const context = createContext(gateway);
    const { palette } = await mountPalette(
      agentContext(
        context,
        [{ id: "reviewer", name: "Reviewer", model: { primary: "fixture/hidden" } }],
        "main",
      ),
    );
    await searchPalette(palette, "fixture/hidden");
    expect(findPaletteOption(palette, "Reviewer")).toBeUndefined();
  });
  it("keeps partial catalog refresh diagnostics out of search and navigation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(modelResult("obsolete", "Needle obsolete"))
      .mockResolvedValueOnce({ ...modelResult("current", "Needle current"), refreshFailed: true })
      .mockResolvedValueOnce({ models: [] });
    const harness = modelGateway(request);
    const { palette, query } = await mountPalette(createContext(harness.gateway, async () => null));
    await searchPalette(palette, "needle");
    expect(findPaletteOption(palette, "Needle obsolete")).toBeDefined();

    harness.emit("chat.metadata.changed");
    await settlePalette(palette);
    expect(findPaletteOption(palette, "Needle obsolete")).toBeUndefined();
    expect(findPaletteOption(palette, "Needle current")).toBeDefined();
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(query(".cmd-palette__source-error")).toBeNull();
    expect(query(".cmd-palette__no-results")).toBeNull();

    await enterQuery(palette, "");
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Agents")).toBeDefined();
    expect(query(".cmd-palette__source-error")).toBeNull();
    await searchPalette(palette, "needle");
    harness.emit("chat.metadata.changed");
    await settlePalette(palette);
    expect(findPaletteOption(palette, "Needle current")).toBeUndefined();
    expect(query(".cmd-palette__source-error")).toBeNull();
  });

  it("clears choices after a failed model-selection change and retries on input", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(modelResult("old", "Needle old"))
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce(modelResult("new", "Needle new"));
    const harness = modelGateway(request);
    const { palette, query } = await mountPalette(createContext(harness.gateway, async () => null));
    await searchPalette(palette, "needle");
    expect(findPaletteOption(palette, "Needle old")).toBeDefined();

    harness.emit("chat.metadata.changed", { modelSelectionChanged: true });
    await settlePalette(palette);
    expect(query('.cmd-palette__search [role="status"]')?.textContent).toContain(
      "Model search unavailable",
    );
    expect(findPaletteOption(palette, "Needle old")).toBeUndefined();

    await searchPalette(palette, "needle");
    expect(findPaletteOption(palette, "Needle new")).toBeDefined();
    expect(findPaletteOption(palette, "Needle old")).toBeUndefined();
    expect(query(".cmd-palette__source-error")).toBeNull();
  });
  it.each(["agent", "source", "connection", "detach", "publication", "closed"])(
    "fences retained and pending catalog rows on %s replacement",
    async (replacement) => {
      const stale = createDeferred<ReturnType<typeof modelResult>>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(modelResult("old", "Needle old"))
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(modelResult("new", "Needle new"));
      const harness = modelGateway(request);
      const context = createContext(harness.gateway, async () => null);
      const { palette, provider, query } = await mountPalette(context);
      await searchPalette(palette, "needle");
      expect(findPaletteOption(palette, "Needle old")).toBeDefined();
      harness.emit("config.changed");
      await vi.advanceTimersByTimeAsync(200);
      if (replacement === "agent") {
        context.agentSelection.set("reviewer");
      } else if (replacement === "source") {
        const next = modelGateway(request);
        provider.setContext(createContext(next.gateway, async () => null));
      } else if (replacement === "connection") {
        harness.setConnected(false);
      } else if (replacement === "detach") {
        palette.remove();
        harness.emit("chat.metadata.changed");
      } else if (replacement === "closed") {
        palette.togglePalette();
        harness.emit("chat.metadata.changed");
      } else {
        harness.emit("chat.metadata.changed");
      }
      await palette.updateComplete;
      if (replacement !== "publication") {
        expect(findPaletteOption(palette, "Needle old")).toBeUndefined();
      }
      if (replacement === "connection") {
        harness.setConnected(true);
      } else if (replacement === "source") {
        expect(palette.isOpen).toBe(false);
        await openPalette(palette);
        expect(query<HTMLTextAreaElement>(".cmd-palette__input")?.value).toBe("");
        await enterQuery(palette, "needle");
      } else if (replacement === "detach") {
        provider.append(palette);
        await enterQuery(palette, "needle");
      } else if (replacement === "closed") {
        await enterQuery(palette, "needle");
      }
      await vi.advanceTimersByTimeAsync(200);
      stale.resolve(modelResult("stale", "Needle stale"));
      await settlePalette(palette);
      expect(findPaletteOption(palette, "Needle new")).toBeDefined();
      expect(findPaletteOption(palette, "Needle stale")).toBeUndefined();
      if (replacement === "agent") {
        expect(request).toHaveBeenLastCalledWith("models.list", {
          view: "configured",
          agentId: "reviewer",
        });
      }
    },
  );

  it.each([
    { name: "60 Unicode code points", prompt: "🦞".repeat(60) },
    { name: "an internal newline", prompt: "plugins\nsettings" },
  ])("preserves $name as a prompt without sending searches", async ({ prompt }) => {
    const request = vi.fn(async (_method: string) => ({ models: [], results: [] }));
    const list = vi.fn(async () => null);
    const { palette, query } = await mountSearch({ methods: ["sessions.search"], request }, list);

    await searchPalette(palette, prompt);

    const input = paletteInput(palette);
    expect([list.mock.calls, request.mock.calls]).toEqual([[], []]);
    expectPalettePromptMode(palette);
    for (const key of ["ArrowUp", "ArrowDown"]) {
      expect(pressKey(input, key, { cancelable: true }).defaultPrevented).toBe(false);
    }
    expect(pressKey(input, "Enter", { cancelable: true }).defaultPrevented).toBe(true);
    expect(palette.onNavigate).not.toHaveBeenCalled();
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(input.value).toBe(prompt);

    setInputValue(input, "plugins");
    await settlePalette(palette);
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "plugins" }));
    expect(query('[inert][aria-hidden="true"]')).toBeNull();
    expect(input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
    expect(findPaletteOption(palette, "Plugins", true)).toBeDefined();
  });
  it("keeps the current mode between 50 and 60 Unicode code points", async () => {
    const character = "🦞";
    const list = vi.fn(async () => null);
    const { palette, query } = await mountSearch({ methods: ["sessions.search"] }, list);
    await searchPalette(palette, character.repeat(59));
    expect(list).toHaveBeenCalledOnce();
    const input = paletteInput(palette);
    for (const length of [60, 59, 51, 55, 60]) {
      setInputValue(input, " " + character.repeat(length) + " ");
      await settlePalette(palette);
      expectPalettePromptMode(palette);
      expect(list).toHaveBeenCalledOnce();
    }
    setInputValue(input, " " + character.repeat(50) + " ");
    await settlePalette(palette);
    expect(input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: character.repeat(50) }),
    );
    setInputValue(input, character.repeat(59));
    await settlePalette(palette);
    expect(input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
    expect(list).toHaveBeenCalledTimes(3);
    setInputValue(input, character.repeat(60));
    await palette.updateComplete;
    expectPalettePromptMode(palette);
    setInputValue(input, "");
    await palette.updateComplete;
    expect(input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
    palette.togglePalette();
    await palette.updateComplete;
    await searchPalette(palette, character.repeat(55));
    expect(input.isConnected).toBe(false);
    expect(query(".cmd-palette__input")?.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
    expect(list).toHaveBeenCalledTimes(4);
  });
  it("waits for two characters before searching sessions", async () => {
    const list = vi.fn(async () => createSessionResult("agent:main:test", "Test"));
    const { palette, query } = await mountSearch({ methods: ["sessions.search"] }, list);

    await searchPalette(palette, "n");

    expect(list).not.toHaveBeenCalled();
    expect(query('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(query('[role="listbox"]')?.getAttribute("aria-label")).toBe(
      query("textarea")?.getAttribute("aria-label"),
    );
    expect(palette.textContent).not.toContain("Searching sessions");
  });

  it.each([
    ["Reviewer", "agents", "/settings/agents/reviewer%2Eteam", "", true, ""],
    ["Workboard", "plugin-settings", "/settings/plugins/w%2Eb", "w.b", true, ""],
    ["Workboard", "plugins", "/plugins/ch_d29ya2JvYXJk", "workboard", false, "ch_d29ya2JvYXJk"],
  ])(
    "opens the selected %s destination by keyboard",
    async (label, route, pathname, pluginId, installed, catalogId) => {
      const plugin = {
        id: pluginId,
        name: "Workboard",
        installed,
        catalogId: catalogId || undefined,
        enabled: false,
        state: installed ? "disabled" : "not-installed",
      };
      const { gateway } = createGateway(true, {
        methods: ["plugins.list"],
        request: async (rpc) => {
          if (rpc !== "plugins.list") {
            throw new Error(`Unexpected method: ${rpc}`);
          }
          return { plugins: pluginId ? [plugin] : [] };
        },
      });
      const context = createContext(gateway, async () => null);
      const { palette, query } = await mountPalette({
        ...agentContext(context, [{ id: "reviewer.team", name: "Reviewer" }]),
        basePath: "/openclaw",
      });
      await searchPalette(palette, label);
      const item = query<HTMLElement>('[role="option"]');
      expect(item?.textContent).toContain(label);
      pressKey(paletteInput(palette), "Enter");
      expect(palette.onNavigate).toHaveBeenCalledExactlyOnceWith(route, {
        pathname: `/openclaw${pathname}`,
      });
      expect(palette.isOpen).toBe(false);
    },
  );

  it("moves the keyboard selection through catalog groups in visible order", async () => {
    const { gateway } = createGateway(true, {
      methods: ["cron.list"],
      request: vi.fn(async () => ({
        jobs: [{ id: "bravo", name: "Needle Bravo" }],
      })),
    });
    const context = createContext(gateway);
    const { palette, query, queryAll } = await mountPalette(
      agentContext(
        context,
        [
          { id: "alpha", name: "Needle Alpha" },
          { id: "charlie", name: "Needle Charlie" },
        ],
        "alpha",
      ),
    );
    await searchPalette(palette, "Needle");
    const items = [...queryAll<HTMLElement>('[role="option"]')];
    expect(items.map((item) => item.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Needle Alpha alpha",
      "Needle Charlie charlie",
      "Needle Bravo",
    ]);
    for (const expectedIndex of [1, 2, 0]) {
      pressKey(paletteInput(palette), "ArrowDown");
      await palette.updateComplete;
      expect(query('[aria-selected="true"]')).toBe(items[expectedIndex]);
    }
  });

  it("scrolls the current session result across search groups and stops after closing", async () => {
    const listed = createSessionResult("agent:main:scroll-target", "Needle topic");
    const transcript: SessionsSearchResult = {
      sessions: listed.sessions,
      results: [
        {
          sessionKey: listed.sessions[0]!.key,
          sessionId: "scroll-target",
          messageId: "scroll-message",
          role: "assistant",
          timestamp: 42,
          snippet: "The payload appears in this conversation.",
          score: 10,
        },
      ],
    };
    const { palette, query, queryAll } = await mountSearch(
      {
        methods: ["sessions.search"],
        request: async (method) => (method === "sessions.search" ? transcript : { models: [] }),
      },
      vi.fn(async () => listed),
    );
    for (const search of ["needle", "payload", "needle"]) {
      await searchPalette(palette, search);
      expect(queryAll('[role="option"]')).toHaveLength(1);
      expect(query(".cmd-palette__group-label")?.textContent?.includes("In messages")).toBe(
        search === "payload",
      );
      const row = query<HTMLElement>('[role="option"]')!;
      const scroll = vi.fn();
      Object.defineProperty(row, "scrollIntoView", { configurable: true, value: scroll });
      pressKey(paletteInput(palette), "ArrowDown");
      await palette.updateComplete;
      await vi.advanceTimersByTimeAsync(20);
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    }
    const row = query<HTMLElement>('[role="option"]')!;
    const scroll = vi.fn();
    Object.defineProperty(row, "scrollIntoView", { configurable: true, value: scroll });
    pressKey(paletteInput(palette), "ArrowDown");
    pressKey(paletteInput(palette), "Escape");
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(20);
    expect(palette.isOpen).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each(["retain", "navigate"])(
    "keeps selection actionable when a chosen session disappears and returns (%s)",
    async (interaction) => {
      const sessions = [0, 9].map(
        (id) => createSessionResult(`agent:main:qa-${id}`, `Agent QA ${id}`).sessions[0]!,
      );
      const list = vi.fn(async () => ({
        ...createSessionResult("agent:main:qa-0", "Agent QA 0"),
        count: sessions.length,
        sessions,
      }));
      const { palette, query, setConnected } = await mountSearch({}, list);
      await searchPalette(palette, "agent");
      const session = findPaletteOption(palette, "Agent QA 9")!;
      const sessionText = session.textContent;
      session.dispatchEvent(new MouseEvent("mouseenter"));
      await palette.updateComplete;

      setConnected(false);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Agent QA 9")).toBeUndefined();
      const first = query('[role="option"]');
      expect(query('[aria-selected="true"]')).toBe(first);
      const input = paletteInput(palette);
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(first);
      if (interaction === "navigate") {
        pressKey(input, "ArrowDown");
        await palette.updateComplete;
      }
      const offlineSelection = query('[aria-selected="true"]')?.textContent;

      setConnected(true);
      await palette.updateComplete;
      await settlePalette(palette);
      const active = query('[aria-selected="true"]');
      expect(active?.textContent).toEqual(
        interaction === "retain" ? sessionText : offlineSelection,
      );
      pressKey(input, "Enter");
      expect(palette.isOpen).toBe(false);
      if (interaction === "retain") {
        expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:qa-9");
      } else {
        expect(palette.onSelectSession).not.toHaveBeenCalled();
        expect(palette.onNavigate).toHaveBeenCalledOnce();
      }
    },
  );

  it("resolves the retained catalog selection after a shrinking refresh", async () => {
    const { gateway } = createGateway(true);
    const context = createContext(gateway);
    const roster = {
      defaultId: "a",
      mainKey: "main",
      scope: "per-sender" as const,
      agents: [
        { id: "a", name: "Review Alpha" },
        { id: "b", name: "Review Bravo" },
        { id: "c", name: "Review Charlie" },
      ],
    };
    const refresh = createDeferred<typeof roster>();
    const ensureList = vi.fn().mockResolvedValueOnce(roster).mockReturnValueOnce(refresh.promise);
    const { palette, query, queryAll } = await mountPalette({
      ...context,
      agents: { ...context.agents, ensureList },
    });
    await searchPalette(palette, "review");
    vi.setSystemTime(Date.now() + 30_001);
    const input = paletteInput(palette);
    setInputValue(input, "review ");
    await settlePalette(palette);
    for (let i = 0; i < 2; i++) {
      pressKey(input, "ArrowDown");
      await palette.updateComplete;
    }
    expect(query('[aria-selected="true"]')?.textContent).toContain("Review Charlie");
    refresh.resolve({
      ...roster,
      agents: roster.agents.slice(2),
    });
    await vi.waitFor(() => expect(queryAll('[role="option"]')).toHaveLength(1));
    await palette.updateComplete;
    const remaining = query('[role="option"]');
    expect(query('[aria-selected="true"]')).toBe(remaining);
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(remaining);
    pressKey(input, "Enter");
    expect(palette.onNavigate).toHaveBeenCalledWith("agents", {
      pathname: "/settings/agents/c",
    });
    expect(palette.isOpen).toBe(false);
  });
  it("distinguishes model choices with hyphenated provider and model IDs", async () => {
    const { palette, query } = await mountSearch({
      methods: ["models.list"],
      request: vi.fn(async () => ({
        models: [
          { provider: "qa", id: "custom-model", name: "Needle Alpha" },
          { provider: "qa-custom", id: "model", name: "Needle Bravo" },
        ],
      })),
    });
    await searchPalette(palette, "needle");
    pressKey(paletteInput(palette), "ArrowDown");
    await palette.updateComplete;
    expect(query('[aria-selected="true"]')?.textContent).toContain("Needle Bravo");
  });

  it("keeps the active descendant bound for a surrogate-containing session key", async () => {
    const key = "agent:main:topic:\ud800";
    const colon = createSessionResult(key, "Needle colon");
    const hyphen = createSessionResult("agent:main:topic-thread", "Needle hyphen");
    const { palette, query } = await mountSearch(
      {},
      vi.fn(async () => ({
        ...colon,
        count: 2,
        sessions: [...colon.sessions, ...hyphen.sessions],
      })),
    );
    await searchPalette(palette, "Needle");
    pressKey(paletteInput(palette), "ArrowDown");
    await palette.updateComplete;
    const active = query('[aria-selected="true"]');
    expect(active?.textContent).toContain("Needle hyphen");
    const activeId = paletteInput(palette).getAttribute("aria-activedescendant");
    expect(document.getElementById(activeId ?? "")).toBe(active);
  });
  it("shows category metadata matches from the Gateway search", async () => {
    const categorized = createSessionResult("agent:main:categorized", "Unrelated title");
    categorized.sessions[0]!.category = "Tak";
    const list = vi.fn<ApplicationContext["sessions"]["list"]>(async () => categorized);
    const request = vi.fn(async (method: string) =>
      method === "models.list" ? { models: [] } : ({ results: [] } satisfies SessionsSearchResult),
    );
    const { palette } = await mountSearch({ methods: ["sessions.search"], request }, list);

    await enterQuery(palette, "tak");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(1),
    );
    await palette.updateComplete;

    expect(palette.textContent).toContain("Unrelated title");
  });

  it("shows a chat search failure for plugins and retries after shortening a prompt", async () => {
    const query = "plugins";
    const list = vi
      .fn<ApplicationContext["sessions"]["list"]>()
      .mockRejectedValueOnce(new Error("store needs doctor migration"))
      .mockResolvedValueOnce(createSessionResult("agent:main:zz", "Recovered chat"));
    const { palette } = await mountSearch({}, list);
    await searchPalette(palette, query);

    expect(list).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Chat search failed");
    expect(palette.textContent).not.toContain("No results");
    expect(findPaletteOption(palette, "Plugins")).toBeDefined();

    const input = paletteInput(palette);
    setInputValue(input, `${query}\nExplain what needs to be repaired in a new session.`);
    await settlePalette(palette);
    expectPalettePromptMode(palette);
    expect(list).toHaveBeenCalledOnce();

    setInputValue(input, "zz");
    await palette.updateComplete;
    expect(palette.textContent).not.toContain("Chat search failed");
    await settlePalette(palette);
    expect(palette.textContent).toContain("Recovered chat");
  });

  it("opens the capture section from the palette without losing its deep link", async () => {
    const { gateway } = createGateway(true, { methods: [] });
    gateway.snapshot.hello!.auth = { role: "operator", scopes: ["operator.admin"] };
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    await searchPalette(palette, "meeting capture");
    const item = findPaletteOption(palette, "Meeting capture");
    expect(item).toBeDefined();
    item!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("communications", {
      search: "?section=transcripts",
      hash: "#settings-communications-meeting-capture",
    });
  });

  it("flushes a new query on Enter without selecting the retained command", async () => {
    const { palette } = await mountSearch(
      {},
      vi.fn(async () => createSessionResult("agent:main:test", "Test")),
    );
    await searchPalette(palette, "plugins");

    const input = paletteInput(palette);
    setInputValue(input, "settings");
    await palette.updateComplete;
    const stale = findPaletteOption(palette, "Plugins")!;
    expect(stale.getAttribute("aria-disabled")).toBe("true");
    stale.click();
    expect(palette.onNavigate).not.toHaveBeenCalled();

    pressKey(input, "Enter");
    await palette.updateComplete;
    expect(palette.onNavigate).toHaveBeenCalledExactlyOnceWith("appearance");
    expect(palette.isOpen).toBe(false);
  });

  it.each([
    ["desktop", true, "Desktop", DESKTOP_PANEL_TOGGLE_EVENT],
    ["openclaw", false, "Ask OpenClaw", CUSTODIAN_PANEL_TOGGLE_EVENT],
  ] as const)("opens the %s panel action", async (query, desktop, label, event) => {
    const { palette } = await mountSearch(
      {},
      vi.fn(async () => createSessionResult("agent:main:test", "Test")),
    );
    palette.desktopAvailable = desktop;
    palette.custodianAvailable = !desktop;
    await searchPalette(palette, query);
    const listener = vi.fn();
    window.addEventListener(event, listener);
    try {
      findPaletteOption(palette, label, true)?.click();
    } finally {
      window.removeEventListener(event, listener);
    }
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ detail: { open: true } }),
    );
  });
});
