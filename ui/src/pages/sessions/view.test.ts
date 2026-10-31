/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createSessionGoalFixture } from "../../../../src/gateway/session-goal.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createOverlay, type Overlay } from "../../components/overlay-lifecycle.ts";
import { registerModalSurface } from "../../components/overlay-registry.ts";
import {
  disposeSessionViews,
  renderSessionsView,
  buildMultiResult,
  buildProps,
  buildResult,
} from "./view.test-support.tsx";

type SessionRow = Parameters<typeof buildResult>[0];
const createRow = (key: string, overrides: Partial<SessionRow> = {}): SessionRow => ({
  key,
  kind: "direct",
  ...overrides,
});
function renderView(
  result: Parameters<typeof buildProps>[0] | SessionRow | SessionRow[],
  overrides: Partial<ReturnType<typeof buildProps>> = {},
) {
  const list = Array.isArray(result)
    ? buildMultiResult(result)
    : "sessions" in result
      ? result
      : buildResult(result);
  renderSessionsView({ ...buildProps(list), ...overrides }, container);
}
const renderSettled = async (...args: Parameters<typeof renderView>) => {
  renderView(...args);
  await Promise.resolve();
};
const mainSession = (overrides: Partial<SessionRow>): SessionRow =>
  createRow("agent:main:main", { updatedAt: Date.now(), ...overrides });
const renderDetails = (
  row: Partial<SessionRow>,
  props: Partial<ReturnType<typeof buildProps>> = {},
) => renderSettled(mainSession(row), { expandedSessionKey: "agent:main:main", ...props });

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
});
afterEach(() => {
  disposeSessionViews();
  container.remove();
});
const query = (selector: string, root: ParentNode = container) => root.querySelector(selector);
const queryAll = <T extends Element = Element>(selector: string, root: ParentNode = container) =>
  root.querySelectorAll<T>(selector);
const attr = (selector: string, name: string) => query(selector)?.getAttribute(name);

const text = (selector: string, root: ParentNode | null | undefined = container) =>
  root?.querySelector(selector)?.textContent?.trim();
const texts = (selector: string, root: ParentNode = container) =>
  [...queryAll(selector, root)].map((el) => el.textContent?.trim());
const expectTexts = (selector: string, expected: string[], root?: ParentNode) =>
  expect(texts(selector, root)).toEqual(expected);
const optionValues = (select: HTMLSelectElement | undefined | null) =>
  Array.from(select?.options ?? [], (option) => option.value);
const getButton = (selector: string) => container.querySelector<HTMLButtonElement>(selector);
const getInput = (selector: string) => container.querySelector<HTMLInputElement>(selector);
const getSelect = (selector: string) => container.querySelector<HTMLSelectElement>(selector);
function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
function dropOn(row: Element | null, types: string[], data: Record<string, string>) {
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { types, getData: (type: string) => data[type] ?? "" },
  });
  row?.dispatchEvent(drop);
}

describe("sessions view", () => {
  it.each(["bulk", "empty"] as const)(
    "uses current callbacks on retained %s buttons",
    async (kind) => {
      const bulk = kind === "bulk";
      const callbacks = () => ({
        onDeselectAll: vi.fn(),
        onDeleteSelected: vi.fn(),
        onLoadMore: vi.fn(),
        onDeleteAllArchived: vi.fn(),
        onClearFilters: vi.fn(),
      });
      const initial = callbacks();
      const current = callbacks();
      const result = bulk
        ? {
            ...buildResult(createRow("archived", { archived: true })),
            hasMore: true,
            nextOffset: 1,
          }
        : buildMultiResult([]);
      const shared = {
        statusFilter: bulk ? "archived" : "active",
        selectedKeys: new Set(bulk ? ["archived"] : []),
        searchQuery: bulk ? "" : "missing",
      } satisfies Partial<ReturnType<typeof buildProps>>;
      renderView(result, { ...shared, ...initial });
      await Promise.resolve();
      const selectors = bulk
        ? ([
            ["onDeselectAll", ".data-table-bulk-bar button:not(.danger)"],
            ["onDeleteSelected", ".data-table-bulk-bar button.danger"],
            ["onLoadMore", ".data-table-pagination__controls > button:first-of-type"],
            ["onDeleteAllArchived", "#sessions-filter-popover button.danger"],
          ] as const)
        : ([["onClearFilters", ".data-table-empty-state button"]] as const);
      const buttons = selectors.map(([name, selector]) => ({
        name,
        selector,
        button: expectDefined(getButton(selector), name),
      }));
      renderView(result, { ...shared, ...current });
      for (const { name, selector, button } of buttons) {
        expect(query(selector)).toBe(button);
        button.click();
        expect(current[name]).toHaveBeenCalledOnce();
        expect(initial[name]).not.toHaveBeenCalled();
      }
    },
  );

  it("identifies agents on plain chat sessions in a mixed-agent list", () => {
    renderView([
      createRow("agent:main:chat-one"),
      createRow("agent:research:chat-two"),
      createRow("legacy-chat", { agentId: "research" }),
    ]);
    expect(
      [...queryAll(".session-data-row .session-agent-col .agent-row-chip")].map((chip) =>
        chip.getAttribute("data-agent-id"),
      ),
    ).toEqual(["main", "research", "research"]);
    expect(queryAll(".session-key-cell .agent-row-chip")).toHaveLength(0);
  });

  it.each([false, true])(
    "shows the Agent column only in all-agent scope with category grouping %s",
    async (categoryGrouping) => {
      const result = buildResult(
        createRow("agent:research:chat-two", { agentId: "research", category: "Work" }),
      );
      const groupBy = categoryGrouping ? "category" : "none";
      const sharedProps = {
        groupBy,
        knownCategories: ["Work"],
        expandedSessionKey: "agent:research:chat-two",
      } satisfies Partial<ReturnType<typeof buildProps>>;
      let columnCount = 0;
      for (const allAgentsScope of [true, false]) {
        renderView(result, { ...sharedProps, allAgentsScope });
        columnCount = 4 + Number(allAgentsScope) + Number(categoryGrouping);
        expect(queryAll("thead th")).toHaveLength(columnCount);
        if (!categoryGrouping) {
          expectTexts(
            "thead th",
            allAgentsScope
              ? ["", "Session", "Agent", "Updated", "Actions"]
              : ["", "Session", "Updated", "Actions"],
          );
        }
        expect(queryAll(".session-data-row .session-agent-col")).toHaveLength(
          allAgentsScope ? 1 : 0,
        );
        if (!allAgentsScope) {
          expect(queryAll(".session-data-row .agent-row-chip")).toHaveLength(0);
        }
        expect(attr(".session-details-row td", "colspan")).toBe(String(columnCount));
        if (categoryGrouping) {
          expect(attr(".session-group-row td", "colspan")).toBe(String(columnCount));
        }
      }

      const readiness = createDeferred<null>();
      onTestFinished(() => readiness.resolve(null));
      renderView([], {
        ...sharedProps,
        allAgentsScope: false,
        result: null,
        loading: true,
        roster: readiness.promise,
      });
      await vi.waitFor(() =>
        expect(queryAll(".session-skeleton-row:first-child td")).toHaveLength(columnCount),
      );
      renderView([], { ...sharedProps, allAgentsScope: false });
      expect(attr(".data-table-empty-cell", "colspan")).toBe(String(columnCount));
    },
  );

  it("renders local calendar date headings with their session rows", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 2, 9, 12).getTime());
    onTestFinished(() => clock.mockRestore());
    await renderSettled(
      [
        createRow("today", { updatedAt: new Date(2026, 2, 9).getTime() }),
        createRow("yesterday", { updatedAt: new Date(2026, 2, 8).getTime() }),
        createRow("two-days-ago", { updatedAt: new Date(2026, 2, 7, 23, 59).getTime() }),
        createRow("six-days-ago", { updatedAt: new Date(2026, 2, 3).getTime() }),
        createRow("older", { updatedAt: new Date(2026, 2, 2, 23, 59).getTime() }),
      ],
      { groupBy: "date" },
    );

    expectTexts("tbody .session-group-row__label, tbody .session-link", [
      "Today",
      "today",
      "Yesterday",
      "yesterday",
      "This week",
      "two-days-ago",
      "six-days-ago",
      "Older",
      "older",
    ]);
    expect(queryAll("tbody > tr:not([aria-hidden]):not(.session-window-spacer)")).toHaveLength(9);
  });

  it("retains the focused sort button across direction changes", async () => {
    const result = buildMultiResult([]);
    const onSortChange = vi.fn((sortColumn: "key" | "updated", sortDir: "asc" | "desc") => {
      renderView(result, { sortColumn, sortDir, onSortChange });
    });
    document.body.append(container);
    await renderSettled(result, { onSortChange });
    const header = query('thead th[aria-sort="descending"]')!;
    const button = header.querySelector("button")!;
    button.focus();
    for (const direction of ["ascending", "descending"]) {
      button.click();
      expect(query(`thead th[aria-sort="${direction}"]`)).toBe(header);
      expect(header.querySelector("button")).toBe(button);
      expect(document.activeElement).toBe(button);
    }
  });

  it("uses the stored face for generic session links", async () => {
    await renderSettled(
      createRow("agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef", {
        boardFace: "dashboard",
        updatedAt: 1,
      }),
    );

    expect(attr(".session-link", "href")).toBe("/dashboard/main/1234567890abcdef1234567890abcdef");
  });

  it("paginates grouped sessions while preserving full group counts", async () => {
    const onPageChange = vi.fn();
    const result = buildMultiResult([
      { key: "agent:main:discord:channel:1", kind: "group", updatedAt: 3 },
      createRow("agent:main:telegram:direct:2", { updatedAt: 2 }),
      { key: "agent:main:discord:channel:3", kind: "group", updatedAt: 1 },
    ]);
    await renderSettled(result, { groupBy: "channel", pageSize: 2, onPageChange });

    expectTexts(".session-group-row__label", ["discord"]);
    expectTexts(".session-group-row__count", ["2 sessions"]);
    expect(queryAll(".session-data-row")).toHaveLength(2);
    expect(query(".data-table-pagination")?.textContent).toContain("1-2 of 3 rows");

    const next = Array.from(queryAll(".data-table-pagination button")).find(
      (button) => button.textContent?.trim() === "Next",
    );
    expect(next).toBeInstanceOf(HTMLButtonElement);
    next!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    await renderSettled(result, { groupBy: "channel", page: 1, pageSize: 2 });

    expect(text(".session-group-row__label")).toBe("telegram");
    expect(text(".session-group-row__count")).toBe("1 session");
    expect(queryAll(".session-data-row")).toHaveLength(1);
  });

  it("offers person grouping and labels the durable profile", async () => {
    await renderSettled(
      [
        createRow("agent:main:ada", {
          updatedAt: 2,
          owner: {
            actor: {
              type: "human",
              id: "profile-ada",
              label: "Ada Lovelace",
              identity: { type: "profile", id: "profile-ada" },
            },
          },
        }),
        createRow("agent:main:ownerless", { updatedAt: 1 }),
      ],
      { groupBy: "person" },
    );

    expect(text('.session-groupby__select option[value="person"]')).toBe("Person");
    expectTexts(".session-group-row__label", ["Ada Lovelace", "Ungrouped"]);
  });

  it("opens the session menu from the kebab and row context-menu shortcuts", async () => {
    const onOpenSessionMenu = vi.fn();
    const session = createRow("agent:main:dashboard:1", { updatedAt: Date.now() });
    await renderSettled(session, { onOpenSessionMenu });

    const menuButton = expectDefined(
      getButton('button[aria-label="Open session menu: agent:main:dashboard:1"]'),
      "session menu",
    );
    expect(menuButton.getAttribute("aria-haspopup")).toBe("menu");
    const expectMenuCall = (call: number, x: number, y: number, trigger: Element | null) =>
      expect(onOpenSessionMenu).toHaveBeenNthCalledWith(
        call,
        expect.objectContaining({ key: session.key }),
        { x, y },
        trigger,
      );
    menuButton.click();
    expectMenuCall(1, expect.any(Number), expect.any(Number), menuButton);
    const row = expectDefined(query(".session-data-row"), "session row");
    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 123,
      clientY: 45,
    });
    row.dispatchEvent(contextMenu);
    expectMenuCall(2, 123, 45, null);
    expect(contextMenu.defaultPrevented).toBe(true);

    const keyboardContextMenu = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "F10",
      shiftKey: true,
    });
    row.dispatchEvent(keyboardContextMenu);
    expectMenuCall(3, expect.any(Number), expect.any(Number), menuButton);
    expect(keyboardContextMenu.defaultPrevented).toBe(true);
  });

  it("keeps pinned sessions above newer unpinned sessions", async () => {
    await renderSettled([
      createRow("newer", { updatedAt: 200 }),
      createRow("pinned", { updatedAt: 100, pinned: true, pinnedAt: 300 }),
    ]);

    expectTexts("tbody .session-data-row .session-key-cell__primary", ["pinned", "newer"]);
  });

  it("keeps session filters in the header popover without a count badge", async () => {
    const onSearchChange = vi.fn();
    document.body.append(container);
    await renderSettled([], {
      activeMinutes: "120",
      limit: "200",
      includeGlobal: true,
      searchQuery: "keep me",
      onSearchChange,
    });

    const trigger = getButton(".settings-section__actions .sessions-filter-popover__trigger");
    const popover = query(".settings-section__actions .sessions-filter-popover");
    expect(queryAll(".sessions-filter-bar, .settings-count")).toHaveLength(0);
    expect(trigger?.textContent?.trim()).toBe("");
    expect(trigger?.getAttribute("aria-label")).toBe("Filters");
    expect(trigger?.getAttribute("title")).toBeNull();
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    trigger?.click();
    expect(popover?.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(popover);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const escape = escapeKey();
    popover?.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(getInput(".sessions-filter-popover__search input")?.value).toBe("keep me");
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  it.each(["provider-owned", "legacy binary"])(
    "renders and patches %s thinking ids",
    async (mode) => {
      const binary = mode === "legacy binary";
      const onPatch = vi.fn();
      await renderDetails(
        binary
          ? { thinkingLevel: "low", thinkingOptions: ["off", "on"] }
          : {
              thinkingLevel: "adaptive",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "adaptive", label: "adaptive" },
                { id: "max", label: "maximum" },
              ],
            },
        { onPatch },
      );
      const thinking = getSelect("tbody select");
      const value = binary ? "low" : "max";
      expect(thinking?.value).toBe(binary ? "low" : "adaptive");
      if (!binary) {
        expect(optionValues(thinking)).toEqual(["", "off", "adaptive", "max"]);
      }
      expect(
        Array.from(thinking?.options ?? [])
          .find((option) => option.value === value)
          ?.textContent?.trim(),
      ).toBe(binary ? "On" : "Maximum");
      change(thinking!, value);
      expect(onPatch).toHaveBeenCalledWith("agent:main:main", { thinkingLevel: value });
    },
  );

  it("shows agent identity name and emoji for matching session keys", async () => {
    await renderSettled(
      createRow("agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN", { updatedAt: Date.now() }),
      {
        agentIdentityById: {
          "data-expert": {
            agentId: "data-expert",
            name: "Data Expert",
            avatar: "",
            emoji: "📊",
          },
        },
      },
    );

    const keyCell = query(".session-key-cell");
    expect(text(".session-key-cell__primary", keyCell)).toBe("📊 Data Expert (dingtalk)");
    expect(keyCell?.getAttribute("data-tooltip")).toBe("📊 Data Expert (dingtalk)");
  });

  it("opens session details from row activation", async () => {
    const onToggleDetails = vi.fn();
    await renderSettled(mainSession({ totalTokens: 123456, contextTokens: 200000 }), {
      onToggleDetails,
    });

    const row = container.querySelector<HTMLTableRowElement>("tbody tr.session-data-row");
    expect(row).toBeInstanceOf(HTMLTableRowElement);
    row!
      .querySelector<HTMLInputElement>("input[type=checkbox]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggleDetails).not.toHaveBeenCalled();
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleDetails).toHaveBeenCalledWith("agent:main:main");
    expect(query(".session-token-cell")).toBeNull();
  });

  it("renders expanded session details without checkpoint actions", async () => {
    await renderDetails(
      {
        totalTokens: 123456,
        contextTokens: 200000,
        model: "gpt-5.5",
        modelProvider: "openai",
        status: "running",
        runtimeMs: 125000,
        goal: createSessionGoalFixture("goal-1", "Finish the compaction details", {
          status: "blocked",
          tokensUsed: 24_000,
          lastStatusNote: "Waiting for owner review",
        }),
      },
      {
        patchAdminDisabledReason: "Operator admin access is required.",
      },
    );

    const details = expectDefined(query(".session-details-panel"), "session details");
    expect(text(".session-details-panel__eyebrow", details)).toBe("Session details");
    expect(text(".session-details-panel__title", details)).toBe("agent:main:main");
    expect(
      texts(".session-details-panel__badges > *", details).map((s) => s?.replace(/\s+/g, " ")),
    ).toEqual(["Live", "Goal blocked (24k used)", "direct"]);
    const stats = Object.fromEntries(
      [...queryAll(".session-detail-stat", details)].map((stat) => [
        text(".session-detail-stat__label", stat) ?? "",
        text(".session-detail-stat__value", stat) ?? "",
      ]),
    );
    expect(stats).toMatchObject({
      Status: "running",
      Model: "gpt-5.5",
      Provider: "openai",
      Runtime: "-",
      "Run duration": "2m 5s",
      Tokens: "123456 / 200000",
      Goal: "Goal blocked (24k used): Finish the compaction details - Waiting for owner review",
      "Goal note": "Waiting for owner review",
    });
    expect(Object.hasOwn(stats, "Compaction")).toBe(false);

    const selects = queryAll<HTMLSelectElement>(".session-override-field select", details);
    expect(selects).toHaveLength(4);
    for (const select of selects) {
      expect(select).toMatchObject({ disabled: true, title: "Operator admin access is required." });
    }

    await renderSettled(
      [
        createRow("agent:main:cron:live", { updatedAt: 40, hasActiveRun: true, status: "queued" }),
        createRow("agent:main:idle", {
          unread: true,
          totalTokens: 300,
          updatedAt: 20,
          hasActiveRun: false,
          status: "running",
        }),
      ],
      { expandedSessionKey: "agent:main:cron:live" },
    );
    expect(
      queryAll(
        ".session-data-row .settings-status, .settings-count, .sessions-heading-fact, .session-data-row .session-avatar",
      ),
    ).toHaveLength(0);
    expect(text(".session-details-panel__badges")).toContain("Queued");
    expect(text(".session-kind--cron")).toBe("cron");
  });

  it("keeps session selects stable and deselects only the current page", async () => {
    const initial = buildResult(
      mainSession({ fastMode: true, verboseLevel: "full", reasoningLevel: "custom-mode" }),
    );
    await renderSettled(initial, { expandedSessionKey: "agent:main:main" });

    const selects = queryAll<HTMLSelectElement>("tbody select");
    const stats = [...queryAll(".session-detail-stat")];
    const [, fast, verbose, reasoning] = selects;
    expect([fast?.value, verbose?.value, reasoning?.value]).toEqual(["on", "full", "custom-mode"]);
    expect(optionValues(verbose)).toEqual(["", "off", "on", "full"]);
    expect(optionValues(reasoning)).toEqual(["", "off", "on", "stream", "custom-mode"]);

    document.body.append(container);
    fast!.focus();
    fast!.value = "off";
    renderView(
      { ...initial, sessions: [{ ...initial.sessions[0]!, updatedAt: Date.now() + 1 }] },
      { expandedSessionKey: "agent:main:main" },
    );
    const refreshed = queryAll("tbody select");
    expect([...queryAll(".session-detail-stat")]).toEqual(stats);
    for (const [index, select] of [...selects].entries()) {
      expect(refreshed[index]).toBe(select);
    }
    expect(document.activeElement).toBe(fast);
    expect(fast!.value).toBe("off");
    container.remove();

    const onSelectPage = vi.fn();
    const onDeselectPage = vi.fn();
    const onDeselectAll = vi.fn();
    await renderSettled(
      [createRow("page-0", { updatedAt: 20 }), createRow("page-1", { updatedAt: 10 })],
      {
        pageSize: 1,
        selectedKeys: new Set(["page-0", "off-page"]),
        onSelectPage,
        onDeselectPage,
        onDeselectAll,
      },
    );

    const headerCheckbox = getInput("thead input[type=checkbox]");
    expect(headerCheckbox).toBeInstanceOf(HTMLInputElement);
    headerCheckbox!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onDeselectPage).toHaveBeenCalledWith(["page-0"]);
    expect(onDeselectAll).not.toHaveBeenCalled();
    expect(onSelectPage).not.toHaveBeenCalled();
  });
});

describe("session category controls", () => {
  it("distinguishes a group named __new-group__ from the create action", async () => {
    const category = "__new-group__";
    const onAssignCategory = vi.fn();
    const onRequestNewCategory = vi.fn();
    await renderSettled(
      [
        { key: "agent:main:discord:channel:1", kind: "group", updatedAt: 2 },
        createRow("agent:main:main", { updatedAt: 1, category }),
      ],
      { groupBy: "category", knownCategories: [category], onAssignCategory, onRequestNewCategory },
    );

    expectTexts(".session-group-row__label", [category, "Ungrouped"]);

    const select = queryAll<HTMLSelectElement>('select[aria-label="Move session to a group"]')[1];
    if (!select) {
      throw new Error("Expected group select");
    }
    change(select, category);
    expect(onAssignCategory).toHaveBeenCalledWith("agent:main:discord:channel:1", category);

    select.selectedIndex = select.options.length - 1;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onRequestNewCategory).toHaveBeenCalledWith("agent:main:discord:channel:1");
    expect(select.value).toBe("");

    const headerRow = expectDefined(query(".session-group-row"), "group header");
    dropOn(headerRow, ["text/plain"], { "text/plain": "not-a-session" });
    expect(onAssignCategory).toHaveBeenCalledTimes(1);

    dropOn(headerRow, ["application/x-openclaw-session-key"], {
      "application/x-openclaw-session-key": "agent:main:main",
    });
    expect(onAssignCategory).toHaveBeenCalledWith("agent:main:main", category);
  });

  it("disables category assignment controls without group write access", async () => {
    const onAssignCategory = vi.fn();
    const reason = "Operator write access is required.";
    await renderSettled([createRow("agent:main:main", { updatedAt: 1, category: "Research" })], {
      groupBy: "category",
      knownCategories: ["Research"],
      groupWriteDisabledReason: reason,
      onAssignCategory,
    });

    const select = getSelect('select[aria-label="Move session to a group"]');
    expect(select).toMatchObject({ disabled: true, title: reason });
    if (select) {
      change(select, "");
    }

    dropOn(query(".session-group-row"), ["application/x-openclaw-session-key"], {
      "application/x-openclaw-session-key": "agent:main:main",
    });

    expect(onAssignCategory).not.toHaveBeenCalled();
  });
});

it("preserves the saved ultrafast override until explicitly changed", async () => {
  const key = "agent:main:main";
  const onPatch = vi.fn();
  await renderSettled(createRow(key, { updatedAt: 1, fastMode: "ultrafast" }), {
    expandedSessionKey: key,
    onPatch,
  });

  const fast = expectDefined(queryAll<HTMLSelectElement>("tbody select")[1], "speed override");
  expect(fast.value).toBe("ultrafast");
  expect([...fast.options].some((option) => option.value === "ultrafast")).toBe(true);
  change(fast, "off");
  expect(onPatch).toHaveBeenCalledWith(key, { fastMode: false });
});

const render = (props: Partial<ReturnType<typeof buildProps>>) => renderView([], props);
const unavailable = "Connect to the Gateway to search transcripts.";
const connectionStatus = () => container.querySelector('.settings-section__desc [role="status"]');
const transcriptTrigger = () =>
  container.querySelector<HTMLButtonElement>(".sessions-transcript-search__trigger");
const filterInput = () =>
  container.querySelector<HTMLInputElement>(".sessions-filter-popover__search input")!;
const escapeKey = (options: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...options });

describe("sessions transcript search view", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }])(
    "keeps transcript search open while Escape belongs to composition or a modified shortcut (%j)",
    async (options) => {
      document.body.append(container);
      render({ transcriptSearchQuery: "keep query" });
      transcriptTrigger()!.click();
      await Promise.resolve();
      const input = container.querySelector<HTMLInputElement>(
        ".sessions-transcript-search__input input",
      )!;
      input.focus();
      const event = escapeKey(options);
      input.dispatchEvent(event);
      await Promise.resolve();
      expect(container.contains(input)).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(event.defaultPrevented).toBe(false);
    },
  );
  it.each([true, false])(
    "keeps transcript submission separate from roster filtering (available=%s)",
    async (available) => {
      const onTranscriptSearchChange = vi.fn();
      const onTranscriptSearch = vi.fn();
      render({
        searchQuery: "agent label",
        transcriptSearchAvailable: available,
        transcriptSearchQuery: available ? "  exact phrase  " : "hidden",
        onTranscriptSearchChange,
        onTranscriptSearch,
      });
      await Promise.resolve();

      const rosterFilter = container.querySelector<HTMLInputElement>(
        '.sessions-filter-popover__search input[type="text"]',
      );
      const trigger = transcriptTrigger();
      expect(rosterFilter?.value).toBe("agent label");
      expect(rosterFilter?.getAttribute("aria-label")).toBe("Filter by key, agent, label, kind…");
      expect(trigger?.getAttribute("aria-label")).toBe(
        available ? "Search transcripts" : unavailable,
      );
      expect(trigger?.disabled).toBe(!available);
      expect(container.querySelector(".sessions-transcript-search__input input")).toBeNull();
      expect(connectionStatus()?.textContent).toBe(available ? undefined : unavailable);
      if (available) {
        trigger!.click();
        await Promise.resolve();
        const transcriptInput = container.querySelector<HTMLInputElement>(
          '.sessions-transcript-search__input input[type="search"]',
        );
        expect(transcriptInput?.value).toBe("  exact phrase  ");
        transcriptInput!.value = "different words";
        transcriptInput!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onTranscriptSearchChange).toHaveBeenCalledWith("different words");
        expect(onTranscriptSearch).not.toHaveBeenCalled();
        container
          .querySelector(".sessions-transcript-search__form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      } else {
        expect(trigger?.closest("openclaw-tooltip")).toBeNull();
        render({ transcriptSearchAvailable: true });
        await Promise.resolve();
        expect(connectionStatus()).toBeNull();
        expect(transcriptTrigger()?.disabled).toBe(false);
      }
      expect(onTranscriptSearch).toHaveBeenCalledTimes(available ? 1 : 0);
    },
  );
});

describe("Sessions query clearing", () => {
  it.each([
    "composing",
    "IME keycode",
    "prevented",
    "unfocused",
    "modified",
    "session menu",
    "menu",
    "closed menu",
    "popover",
    "modal",
    "shell modal",
  ])("leaves Escape to its existing owner when %s", (owner) => {
    document.body.append(container);
    const onSearchChange = vi.fn();
    const props = { ...buildProps(buildMultiResult([])), searchQuery: "keep me", onSearchChange };
    let overlay: HTMLElement | undefined;
    let overlayOwner: Overlay | undefined;
    let releaseModal: (() => void) | undefined;
    try {
      if (owner === "session menu") {
        props.sessionMenu = { key: "agent:main:main" };
      }
      render(props);
      container.querySelector<HTMLButtonElement>(".sessions-filter-popover__trigger")!.click();
      const input = filterInput();
      if (owner !== "unfocused") {
        input.focus();
      }
      if (["menu", "closed menu", "popover", "modal", "shell modal"].includes(owner)) {
        overlay = document.createElement(
          owner.endsWith("menu") ? "openclaw-menu-surface" : owner === "modal" ? "dialog" : "div",
        );
        if (owner === "popover") {
          overlay.popover = "manual";
        }
        if (owner === "modal") {
          overlay.setAttribute("open", "");
        }
        if (owner === "shell modal") {
          overlay.className = "shell-nav";
          overlay.setAttribute("aria-modal", "true");
        }
        document.body.append(overlay);
        if (owner === "closed menu") {
          overlay.hidePopover();
        }
        if (owner === "popover") {
          overlayOwner = createOverlay("sessions-search-test", undefined, { dismissEscape: false });
          overlayOwner.bindSurface(overlay);
          overlayOwner.bindTrigger(input);
          expect(overlayOwner.request(true, "none")).toBe(true);
        }
        if (owner === "modal" || owner === "shell modal") {
          releaseModal = registerModalSurface(overlay);
        }
      }
      const event = escapeKey({
        isComposing: owner === "composing",
        keyCode: owner === "IME keycode" ? 229 : 0,
        ctrlKey: owner === "modified",
      });
      if (owner === "prevented") {
        event.preventDefault();
      }
      input.dispatchEvent(event);
      expect(onSearchChange).not.toHaveBeenCalled();
      expect(input.value).toBe("keep me");
      if (owner === "prevented") {
        expect(event.defaultPrevented).toBe(true);
      }
    } finally {
      overlayOwner?.dispose();
      releaseModal?.();
      overlay?.removeAttribute("open");
      overlay?.remove();
    }
  });
});
