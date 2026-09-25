/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { loadModelCatalog } from "../lib/model-catalog-store.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  expectPalettePromptMode,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  type DesktopPanelToggleDetail,
} from "./panel-toggle-contract.ts";

type CustodianPanelToggleDetail = { open?: boolean };

describe("CommandPalette search", () => {
  let restoreDialogPolyfill: () => void;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lazily searches compact automation names once per connection", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        return { models: [] };
      }
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "nightly-invoices",
              name: "Nightly invoices",
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { gateway, emit, setConnected } = createGateway(true, {
      methods: ["cron.list"],
      request,
    });
    const empty = { ...createSessionResult("agent:main:none", "None"), sessions: [] };
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => empty),
      ),
    );

    await enterQuery(palette, "nightly");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(palette.textContent).toContain("Nightly invoices"));
    const item = findPaletteOption(palette, "Nightly invoices");
    item?.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("cron");

    await vi.advanceTimersByTimeAsync(60_000);
    await enterQuery(palette, "invoices");
    await vi.advanceTimersByTimeAsync(200);
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
    const { gateway } = createGateway(true, {
      methods: ["cron.list", "models.list"],
      request: vi.fn(async (method: string) => {
        if (method === "cron.list") {
          return automations.promise;
        }
        if (method === "models.list") {
          return { models: [{ provider: "fixture", id: "needle", name: "Needle model" }] };
        }
        throw new Error(`Unexpected method: ${method}`);
      }) as GatewayBrowserClient["request"],
    });
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => null),
      ),
    );

    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(findPaletteOption(palette, "Needle model")).toBeDefined());
    expect(palette.textContent).toContain("Searching commands");
    findPaletteOption(palette, "Needle model")?.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("model-providers");

    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(200);
    automations.resolve({ jobs: [{ id: "needle-job", name: "Needle automation" }] });
    await vi.waitFor(() => expect(findPaletteOption(palette, "Needle automation")).toBeDefined());
    expect(findPaletteOption(palette, "Needle model")).toBeDefined();
    expect(palette.textContent).not.toContain("Searching commands");
  });

  it("clears a failed model search when another view publishes the catalog", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({ models: [{ provider: "fixture", id: "needle", name: "Needle" }] });
    const { gateway } = createGateway(true, {
      methods: ["models.list"],
      request: (method, params) =>
        method === "models.list" ? request(method, params) : { results: [], sessions: [] },
    });
    const { palette } = await mountPalette(createContext(gateway, async () => null));
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() =>
      expect(palette.querySelector(".cmd-palette__source-error")?.textContent).toContain(
        "Model search unavailable",
      ),
    );

    await loadModelCatalog(gateway.snapshot.client!, { agentId: "main" });
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle")).toBeDefined();
    expect(palette.querySelector(".cmd-palette__source-error")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { restricted: false, matches: true },
    { restricted: true, matches: false },
  ])(
    "searches agent primary models only when selection is unrestricted ($restricted)",
    async ({ restricted, matches }) => {
      const { gateway } = createGateway(true, {
        methods: ["models.list"],
        request: vi.fn(async () => ({
          models: [],
          modelSelectionPolicy: { restricted },
        })) as GatewayBrowserClient["request"],
      });
      const context = createContext(
        gateway,
        vi.fn(async () => null),
      );
      const { palette } = await mountPalette({
        ...context,
        agents: {
          ...context.agents,
          ensureList: async () => ({
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "reviewer", name: "Reviewer", model: { primary: "fixture/hidden" } }],
          }),
        },
      });
      await enterQuery(palette, "fixture/hidden");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(Boolean(findPaletteOption(palette, "Reviewer"))).toBe(matches);
    },
  );

  it.each([false, true])(
    "shows an internal catalog failure and empty recovery (retained rows: %s)",
    async (hasRows) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          models: [{ provider: "fixture", id: "obsolete", name: "Needle obsolete" }],
        })
        .mockResolvedValueOnce({
          models: hasRows ? [{ provider: "fixture", id: "current", name: "Needle current" }] : [],
          refreshFailed: true,
        })
        .mockResolvedValueOnce({ models: [] });
      const harness = createGateway(true, {
        methods: ["models.list"],
        request: (method, params) =>
          method === "models.list" ? request(method, params) : { results: [], sessions: [] },
      });
      const { palette } = await mountPalette(createContext(harness.gateway, async () => null));
      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle obsolete")).toBeDefined();

      harness.emit("chat.metadata.changed");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle obsolete")).toBeUndefined();
      expect(palette.querySelectorAll('[role="option"]')).toHaveLength(hasRows ? 1 : 0);
      expect(palette.querySelector('.cmd-palette__search [role="status"]')?.textContent).toContain(
        hasRows
          ? "Some models could not be refreshed. Open Models to try again."
          : "Models unavailable",
      );

      harness.emit("chat.metadata.changed");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle current")).toBeUndefined();
      expect(palette.querySelector(".cmd-palette__source-error")).toBeNull();
    },
  );

  it.each([
    { event: "config.changed", payload: {}, retainsChoices: false },
    {
      event: "chat.metadata.changed",
      payload: { modelSelectionChanged: true },
      retainsChoices: false,
    },
    { event: "chat.metadata.changed", payload: {}, retainsChoices: true },
  ])(
    "handles a failed $event read (retains: $retainsChoices) and retries on input",
    async ({ event, payload, retainsChoices }) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({ models: [{ provider: "fixture", id: "old", name: "Needle old" }] })
        .mockRejectedValueOnce(new Error("catalog unavailable"))
        .mockResolvedValueOnce({
          models: [{ provider: "fixture", id: "new", name: "Needle new" }],
        });
      const harness = createGateway(true, {
        methods: ["models.list"],
        request: (method, params) =>
          method === "models.list" ? request(method, params) : { results: [], sessions: [] },
      });
      const { palette } = await mountPalette(createContext(harness.gateway, async () => null));
      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle old")).toBeDefined();

      harness.emit(event, payload);
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(palette.querySelector('.cmd-palette__search [role="status"]')?.textContent).toContain(
        "Model search unavailable",
      );
      expect(Boolean(findPaletteOption(palette, "Needle old"))).toBe(retainsChoices);

      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle new")).toBeDefined();
      expect(findPaletteOption(palette, "Needle old")).toBeUndefined();
      expect(palette.querySelector(".cmd-palette__source-error")).toBeNull();
    },
  );

  it.each(["agent", "source", "connection", "detach", "publication", "closed"])(
    "fences retained and pending catalog rows on %s replacement",
    async (replacement) => {
      const stale = createDeferred<{ models: { provider: string; id: string; name: string }[] }>();
      const request = vi
        .fn()
        .mockResolvedValueOnce({ models: [{ provider: "fixture", id: "old", name: "Needle old" }] })
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue({ models: [{ provider: "fixture", id: "new", name: "Needle new" }] });
      const harness = createGateway(true, {
        methods: ["models.list"],
        request: (method, params) =>
          method === "models.list" ? request(method, params) : { results: [], sessions: [] },
      });
      const context = createContext(harness.gateway, async () => null);
      const { palette, provider } = await mountPalette(context);
      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle old")).toBeDefined();
      harness.emit("config.changed");
      await vi.advanceTimersByTimeAsync(200);
      if (replacement === "agent") {
        context.agentSelection.set("reviewer");
      } else if (replacement === "source") {
        const next = createGateway(true, {
          methods: ["models.list"],
          request: (method, params) =>
            method === "models.list" ? request(method, params) : { results: [], sessions: [] },
        });
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
        palette.openPalette();
        await palette.updateComplete;
        expect(palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")?.value).toBe("");
        await enterQuery(palette, "needle");
      } else if (replacement === "detach") {
        provider.append(palette);
        await enterQuery(palette, "needle");
      } else if (replacement === "closed") {
        await enterQuery(palette, "needle");
      }
      await vi.advanceTimersByTimeAsync(200);
      stale.resolve({ models: [{ provider: "fixture", id: "stale", name: "Needle stale" }] });
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
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
    { name: "60 characters", prompt: "x".repeat(60) },
    { name: "60 Unicode code points", prompt: "🦞".repeat(60) },
    {
      name: "a long single-line request",
      prompt:
        "Please review the deployment plan, explain the remaining risks, compare the available options, and prepare a detailed follow-up task that records the evidence before making changes.",
    },
    { name: "an internal newline", prompt: "plugins\nsettings" },
    { name: "text beyond the transcript-search limit", prompt: "x".repeat(4_097) },
  ])("preserves $name as a prompt without sending searches", async ({ prompt }) => {
    const request = vi.fn(async (_method: string) => ({ models: [], results: [] }));
    const { gateway } = createGateway(true, { methods: ["sessions.search"], request });
    const list = vi.fn(async () => null);
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, prompt);
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;

    const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
    expect(input.value).toBe(prompt);
    expect(list).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expectPalettePromptMode(palette);
    for (const key of ["ArrowUp", "ArrowDown"]) {
      const arrow = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      input.dispatchEvent(arrow);
      expect(arrow.defaultPrevented).toBe(false);
    }
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(palette.onNavigate).not.toHaveBeenCalled();
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(input.value).toBe(prompt);

    input.value = "plugins";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "plugins" }));
    expect(palette.querySelector('[inert][aria-hidden="true"]')).toBeNull();
    expect(input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
    expect(findPaletteOption(palette, "Plugins", true)).toBeDefined();
  });

  it.each([
    { name: "59 Unicode code points", query: "🦞".repeat(59) },
    { name: "59 trimmed characters", query: ` ${"x".repeat(59)} ` },
    { name: "surrounding blank lines", query: "\n plugins \n" },
    { name: "a short natural-language query", query: "find my deployment plan" },
  ])("continues searching for $name", async ({ query }) => {
    const request = vi.fn(async (_method: string) => ({ models: [], results: [] }));
    const { gateway } = createGateway(true, { methods: ["sessions.search"], request });
    const list = vi.fn(async () => null);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, query);
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;

    expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: query.trim() }));
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ query: query.trim() }),
    );
    expect(palette.querySelector('[inert][aria-hidden="true"]')).toBeNull();
    expect(palette.querySelectorAll(".cmd-palette__filter")).toHaveLength(3);
    expect(palette.querySelector(".cmd-palette__input")?.getAttribute("aria-controls")).toBe(
      "cmd-palette-listbox",
    );
  });

  it.each(["x", "🦞"])(
    "keeps the current mode between 50 and 60 code points (%s)",
    async (character) => {
      const { gateway } = createGateway(true, { methods: ["sessions.search"] });
      const list = vi.fn(async () => null);
      const { palette } = await mountPalette(createContext(gateway, list));
      await enterQuery(palette, character.repeat(59));
      await vi.advanceTimersByTimeAsync(200);
      expect(list).toHaveBeenCalledOnce();
      const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
      for (const length of [60, 59, 51, 55, 60]) {
        input.value = " " + character.repeat(length) + " ";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(200);
        await palette.updateComplete;
        expectPalettePromptMode(palette);
        expect(list).toHaveBeenCalledOnce();
      }
      input.value = " " + character.repeat(50) + " ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: character.repeat(50) }),
      );
      input.value = character.repeat(59);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
      expect(list).toHaveBeenCalledTimes(3);
      input.value = character.repeat(60);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await palette.updateComplete;
      expectPalettePromptMode(palette);
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await palette.updateComplete;
      expect(input.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
      palette.togglePalette();
      await palette.updateComplete;
      await enterQuery(palette, character.repeat(55));
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(input.isConnected).toBe(false);
      expect(palette.querySelector(".cmd-palette__input")?.getAttribute("aria-controls")).toBe(
        "cmd-palette-listbox",
      );
      expect(list).toHaveBeenCalledTimes(4);
    },
  );

  it("waits for two characters before searching sessions", async () => {
    const { gateway } = createGateway(true, { methods: ["sessions.search"] });
    const list = vi.fn(async () => createSessionResult("agent:main:test", "Test"));
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "n");
    await vi.advanceTimersByTimeAsync(200);

    expect(list).not.toHaveBeenCalled();
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe(
      palette.querySelector("textarea")?.getAttribute("aria-label"),
    );
    expect(palette.textContent).not.toContain("Searching sessions");
  });

  it.each([
    ["Reviewer", "click", "agents", "/settings/agents/reviewer%2Eteam", "", true],
    ["Reviewer", "keyboard", "agents", "/settings/agents/reviewer%2Eteam", "", true],
    ["Workboard", "click", "plugin-settings", "/settings/plugins/workboard", "workboard", true],
    ["Workboard", "keyboard", "plugin-settings", "/settings/plugins/w%2Eb", "w.b", true],
    ["Workboard", "click", "plugins", "", "workboard", false],
    ["Plugins", "click", "plugins", "", "", false],
  ])(
    "opens the selected %s destination by %s",
    async (label, method, route, pathname, pluginId, installed) => {
      const plugin = {
        id: pluginId,
        name: "Workboard",
        installed,
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
      const { palette } = await mountPalette({
        ...context,
        basePath: "/openclaw",
        agents: {
          ...context.agents,
          ensureList: async () => ({
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "reviewer.team", name: "Reviewer" }],
          }),
        },
      });
      await enterQuery(palette, label);
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      const item = palette.querySelector<HTMLElement>('[role="option"]');
      expect(item?.textContent).toContain(label);
      if (method === "click") {
        item?.click();
      } else {
        palette
          .querySelector<HTMLTextAreaElement>(".cmd-palette__input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      if (pathname) {
        expect(palette.onNavigate).toHaveBeenCalledExactlyOnceWith(route, {
          pathname: `/openclaw${pathname}`,
        });
      } else {
        expect(palette.onNavigate).toHaveBeenCalledExactlyOnceWith(route);
      }
      expect(palette.isOpen).toBe(false);
    },
  );

  it("moves the keyboard selection through catalog groups in visible order", async () => {
    const { gateway } = createGateway(true, {
      methods: ["cron.list"],
      request: vi.fn(async () => ({
        jobs: [{ id: "bravo", name: "Needle Bravo" }],
      })) as GatewayBrowserClient["request"],
    });
    const context = createContext(
      gateway,
      vi.fn(async () => null),
    );
    const { palette } = await mountPalette({
      ...context,
      agents: {
        ...context.agents,
        ensureList: async () => ({
          defaultId: "alpha",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "alpha", name: "Needle Alpha" },
            { id: "charlie", name: "Needle Charlie" },
          ],
        }),
      },
    });
    await enterQuery(palette, "Needle");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    const items = [...palette.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(items.map((item) => item.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Needle Alpha alpha",
      "Needle Charlie charlie",
      "Needle Bravo",
    ]);
    for (const expectedIndex of [1, 2, 0]) {
      palette
        .querySelector<HTMLTextAreaElement>(".cmd-palette__input")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await palette.updateComplete;
      expect(palette.querySelector('[aria-selected="true"]')).toBe(items[expectedIndex]);
    }
  });

  it.each(["retain", "navigate"])(
    "keeps selection actionable when a chosen session disappears and returns (%s)",
    async (interaction) => {
      const { gateway, setConnected } = createGateway(true);
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => ({
            ...createSessionResult("agent:main:qa-0", "Agent QA 0"),
            count: 10,
            sessions: Array.from(
              { length: 10 },
              (_, index) =>
                createSessionResult(`agent:main:qa-${index}`, `Agent QA ${index}`).sessions[0]!,
            ),
          })),
        ),
      );
      await enterQuery(palette, "agent");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      const session = findPaletteOption(palette, "Agent QA 9")!;
      const sessionText = session.textContent;
      session.dispatchEvent(new MouseEvent("mouseenter"));
      await palette.updateComplete;

      setConnected(false);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Agent QA 9")).toBeUndefined();
      const first = palette.querySelector('[role="option"]');
      expect(palette.querySelector('[aria-selected="true"]')).toBe(first);
      const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(first);
      if (interaction === "navigate") {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await palette.updateComplete;
      }
      const offlineSelection = palette.querySelector('[aria-selected="true"]')?.textContent;

      setConnected(true);
      await palette.updateComplete;
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      const active = palette.querySelector('[aria-selected="true"]');
      expect(active?.textContent).toEqual(
        interaction === "retain" ? sessionText : offlineSelection,
      );
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(palette.isOpen).toBe(false);
      if (interaction === "retain") {
        expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:qa-9");
      } else {
        expect(palette.onSelectSession).not.toHaveBeenCalled();
        expect(palette.onNavigate).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["removed", "retained"])(
    "resolves the selected catalog item after a shrinking refresh (%s)",
    async (selection) => {
      const { gateway } = createGateway(true);
      const context = createContext(
        gateway,
        vi.fn(async () => null),
      );
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
      const { palette } = await mountPalette({
        ...context,
        agents: { ...context.agents, ensureList },
      });
      await enterQuery(palette, "review");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      vi.setSystemTime(Date.now() + 30_001);
      const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
      input.value = "review ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      for (let i = 0; i < 2; i++) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await palette.updateComplete;
      }
      expect(palette.querySelector('[aria-selected="true"]')?.textContent).toContain(
        "Review Charlie",
      );
      refresh.resolve({
        ...roster,
        agents: selection === "removed" ? roster.agents.slice(0, 1) : roster.agents.slice(2),
      });
      await vi.waitFor(() => expect(palette.querySelectorAll('[role="option"]')).toHaveLength(1));
      await palette.updateComplete;
      const remaining = palette.querySelector('[role="option"]');
      expect(palette.querySelector('[aria-selected="true"]')).toBe(remaining);
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(remaining);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(palette.onNavigate).toHaveBeenCalledWith("agents", {
        pathname: `/settings/agents/${selection === "removed" ? "a" : "c"}`,
      });
      expect(palette.isOpen).toBe(false);
    },
  );

  it("distinguishes model choices with hyphenated provider and model IDs", async () => {
    const { gateway } = createGateway(true, {
      methods: ["models.list"],
      request: vi.fn(async () => ({
        models: [
          { provider: "qa", id: "custom-model", name: "Needle Alpha" },
          { provider: "qa-custom", id: "model", name: "Needle Bravo" },
        ],
      })) as GatewayBrowserClient["request"],
    });
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => null),
      ),
    );
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    palette
      .querySelector<HTMLTextAreaElement>(".cmd-palette__input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await palette.updateComplete;
    expect(palette.querySelector('[aria-selected="true"]')?.textContent).toContain("Needle Bravo");
  });

  it.each(["agent:main:topic:thread", "agent:main:topic:\ud800"])(
    "keeps the active descendant bound for session key %j",
    async (key) => {
      const { gateway } = createGateway(true);
      const colon = createSessionResult(key, "Needle colon");
      const hyphen = createSessionResult("agent:main:topic-thread", "Needle hyphen");
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => ({
            ...colon,
            count: 2,
            sessions: [...colon.sessions, ...hyphen.sessions],
          })),
        ),
      );
      await enterQuery(palette, "Needle");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      palette
        .querySelector<HTMLTextAreaElement>(".cmd-palette__input")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await palette.updateComplete;
      const active = palette.querySelector('[aria-selected="true"]');
      expect(active?.textContent).toContain("Needle hyphen");
      const activeId = palette
        .querySelector<HTMLTextAreaElement>(".cmd-palette__input")
        ?.getAttribute("aria-activedescendant");
      expect(document.getElementById(activeId ?? "")).toBe(active);
    },
  );

  it("requests metadata after discovery exclusions and before the result limit", async () => {
    const list = vi.fn<ApplicationContext["sessions"]["list"]>(async () =>
      createSessionResult("agent:main:visible", "Visible planning"),
    );
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "planning");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expect(list).toHaveBeenCalledExactlyOnceWith({
      search: "planning",
      limit: 10,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
    });
    expect(palette.textContent).toContain("Visible planning");
  });

  it("shows category metadata matches from the Gateway search", async () => {
    const categorized = createSessionResult("agent:main:categorized", "Unrelated title");
    const categorizedRow = categorized.sessions.at(0);
    if (!categorizedRow) {
      throw new Error("Expected categorized session fixture");
    }
    categorized.sessions[0] = { ...categorizedRow, category: "Tak" };
    const list = vi.fn<ApplicationContext["sessions"]["list"]>(async () => categorized);
    const request = vi.fn(async (method: string) =>
      method === "models.list" ? { models: [] } : ({ results: [] } satisfies SessionsSearchResult),
    );
    const { gateway } = createGateway(true, {
      methods: ["sessions.search"],
      request,
    });
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "tak");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(1),
    );
    await palette.updateComplete;

    expect(palette.textContent).toContain("Unrelated title");
  });

  it.each(["zzz-unmatched", "plugins"])("shows a chat search failure for %s", async (query) => {
    const { gateway } = createGateway(true);
    const list = vi
      .fn<ApplicationContext["sessions"]["list"]>()
      .mockRejectedValueOnce(new Error("store needs doctor migration"))
      .mockResolvedValueOnce(createSessionResult("agent:main:zz", "Recovered chat"));
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, query);
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;

    expect(list).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Chat search failed");
    expect(palette.textContent).not.toContain("No results");
    if (query === "plugins") {
      expect(findPaletteOption(palette, "Plugins")).toBeDefined();
    }

    const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
    input.value = `${query}\nExplain what needs to be repaired in a new session.`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expectPalettePromptMode(palette);
    expect(list).toHaveBeenCalledOnce();

    // Shortening the prompt restores search and retries cleanly.
    input.value = "zz";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await palette.updateComplete;
    expect(palette.textContent).not.toContain("Chat search failed");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
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
    await enterQuery(palette, "meeting capture");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    const item = findPaletteOption(palette, "Meeting capture");
    expect(item).toBeDefined();
    item!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("communications", {
      search: "?section=transcripts",
      hash: "#settings-communications-meeting-capture",
    });
  });

  it("flushes a new query on Enter without selecting the retained command", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    await enterQuery(palette, "plugins");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;

    const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
    input.value = "settings";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await palette.updateComplete;
    const stale = findPaletteOption(palette, "Plugins")!;
    expect(stale.getAttribute("aria-disabled")).toBe("true");
    stale.click();
    expect(palette.onNavigate).not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await palette.updateComplete;
    expect(palette.onNavigate).toHaveBeenCalledExactlyOnceWith("appearance");
    expect(palette.isOpen).toBe(false);
  });

  it.each([
    { available: true, expectedCount: 1 },
    { available: false, expectedCount: 0 },
  ])(
    "shows the desktop action only when availability is $available",
    async ({ available, expectedCount }) => {
      const { gateway } = createGateway(true);
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => createSessionResult("agent:main:test", "Test")),
        ),
      );
      palette.desktopAvailable = available;
      await enterQuery(palette, "desktop");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;

      expect(findPaletteOption(palette, "Desktop", true) ? 1 : 0).toBe(expectedCount);
    },
  );

  it("opens the desktop panel from its palette action", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    palette.desktopAvailable = true;
    await enterQuery(palette, "desktop");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    const events: CustomEvent<DesktopPanelToggleDetail>[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent<DesktopPanelToggleDetail>);
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, listener);
    try {
      findPaletteOption(palette, "Desktop", true)?.click();
    } finally {
      window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ open: true });
  });

  it.each([
    { available: true, expectedCount: 1 },
    { available: false, expectedCount: 0 },
  ])(
    "shows Ask OpenClaw only when availability is $available",
    async ({ available, expectedCount }) => {
      const { gateway } = createGateway(true);
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => createSessionResult("agent:main:test", "Test")),
        ),
      );
      palette.custodianAvailable = available;
      await enterQuery(palette, "openclaw");
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;

      expect(findPaletteOption(palette, "Ask OpenClaw", true) ? 1 : 0).toBe(expectedCount);
    },
  );

  it("opens Ask OpenClaw from its palette action", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    palette.custodianAvailable = true;
    await enterQuery(palette, "openclaw");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    const events: CustomEvent<CustodianPanelToggleDetail>[] = [];
    const listener = (event: Event) =>
      events.push(event as CustomEvent<CustodianPanelToggleDetail>);
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, listener);
    try {
      findPaletteOption(palette, "Ask OpenClaw", true)?.click();
    } finally {
      window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ open: true });
  });
});
