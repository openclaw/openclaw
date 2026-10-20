/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

function readSessionDetailStats(root: ParentNode): Map<string, string> {
  return new Map(
    Array.from(root.querySelectorAll(".session-detail-stat")).map((stat) => [
      stat.querySelector(".session-detail-stat__label")?.textContent?.trim() ?? "",
      stat.querySelector(".session-detail-stat__value")?.textContent?.trim() ?? "",
    ]),
  );
}

const sessionTableHeaders = () => texts("thead th");

const SESSION_TABLE_HEADERS = ["", "Session", "Agent", "Updated", "Actions"];

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
});
afterEach(() => {
  disposeSessionViews();
  container.remove();
});
const queryAll = <T extends Element = Element>(selector: string) =>
  container.querySelectorAll<T>(selector);

const text = (selector: string, root: ParentNode | null | undefined = container) =>
  root?.querySelector(selector)?.textContent?.trim();
const texts = (selector: string) => [...queryAll(selector)].map((el) => el.textContent?.trim());
const optionValues = (select: HTMLSelectElement | undefined | null) =>
  Array.from(select?.options ?? [], (option) => option.value);

describe("sessions view", () => {
  it("identifies agents on plain chat sessions in a mixed-agent list", () => {
    renderView([
      createRow("agent:main:chat-one"),
      createRow("agent:research:chat-two"),
      createRow("legacy-chat", { agentId: "research" }),
    ]);
    expect(sessionTableHeaders()).toEqual(SESSION_TABLE_HEADERS);
    expect(
      [...queryAll(".session-data-row .session-agent-col .agent-row-chip")].map((chip) =>
        chip.getAttribute("data-agent-id"),
      ),
    ).toEqual(["main", "research", "research"]);
    expect(queryAll(".session-key-cell .agent-row-chip")).toHaveLength(0);
  });

  it.each([false, true])(
    "shows the Agent column only in all-agent scope with category grouping %s",
    (categoryGrouping) => {
      const result = buildResult(
        createRow("agent:research:chat-two", { agentId: "research", category: "Work" }),
      );
      const groupBy = categoryGrouping ? "category" : "none";
      const sharedProps = {
        groupBy,
        knownCategories: ["Work"],
        expandedSessionKey: "agent:research:chat-two",
      } satisfies Partial<ReturnType<typeof buildProps>>;
      renderView(result, { ...sharedProps, allAgentsScope: true });
      const allHeaders = sessionTableHeaders();
      expect(allHeaders).toEqual(
        categoryGrouping
          ? ["", "Session", "Agent", "Group", "Updated", "Actions"]
          : SESSION_TABLE_HEADERS,
      );
      expect(queryAll(".session-data-row .session-agent-col")).toHaveLength(1);
      expect(container.querySelector(".session-details-row td")?.getAttribute("colspan")).toBe(
        String(allHeaders.length),
      );
      if (categoryGrouping) {
        expect(container.querySelector(".session-group-row td")?.getAttribute("colspan")).toBe(
          String(allHeaders.length),
        );
      }

      renderView(result, { ...sharedProps, allAgentsScope: false });
      const scopedHeaders = sessionTableHeaders();
      expect(scopedHeaders).toEqual(
        categoryGrouping
          ? ["", "Session", "Group", "Updated", "Actions"]
          : ["", "Session", "Updated", "Actions"],
      );
      expect(
        queryAll(".session-data-row .session-agent-col, .session-data-row .agent-row-chip"),
      ).toHaveLength(0);
      expect(container.querySelector(".session-details-row td")?.getAttribute("colspan")).toBe(
        String(scopedHeaders.length),
      );
      if (categoryGrouping) {
        expect(container.querySelector(".session-group-row td")?.getAttribute("colspan")).toBe(
          String(scopedHeaders.length),
        );
      }

      renderView([], {
        ...sharedProps,
        allAgentsScope: false,
        result: null,
        loading: true,
      });
      expect(queryAll(".session-skeleton-row:first-child td")).toHaveLength(scopedHeaders.length);
      renderView([], { ...sharedProps, allAgentsScope: false });
      expect(container.querySelector(".data-table-empty-cell")?.getAttribute("colspan")).toBe(
        String(scopedHeaders.length),
      );
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

    expect(
      [...queryAll("tbody > tr")].map((row) =>
        (
          row.querySelector(".session-group-row__label") ?? row.querySelector(".session-link")
        )?.textContent?.trim(),
      ),
    ).toEqual([
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
  });

  it("makes every session sort header a keyboard-accessible button", async () => {
    const result = buildMultiResult([]);
    const onSortChange = vi.fn((sortColumn: "key" | "updated", sortDir: "asc" | "desc") => {
      renderView(result, { sortColumn, sortDir, onSortChange });
    });
    document.body.append(container);
    for (const [label, column] of [
      ["Session", "key"],
      ["Updated", "updated"],
    ] as const) {
      await renderSettled(result, { onSortChange });

      const header = [...queryAll<HTMLTableCellElement>("thead th")].find(
        (cell) => cell.textContent?.trim() === label,
      );
      const button = header?.querySelector("button");
      expect(button, `${label} must be a native keyboard-accessible button`).toBeInstanceOf(
        HTMLButtonElement,
      );
      expect(button?.type).toBe("button");
      expect(header?.getAttribute("aria-sort")).toBe(column === "updated" ? "descending" : null);
      const initialCallCount = onSortChange.mock.calls.length;
      const firstDirection = column === "updated" ? "asc" : "desc";
      button!.focus();
      button!.click();
      expect(onSortChange).toHaveBeenCalledTimes(initialCallCount + 1);
      expect(onSortChange).toHaveBeenLastCalledWith(column, firstDirection);
      const refreshed = [...queryAll<HTMLTableCellElement>("thead th")].find(
        (cell) => cell.textContent?.trim() === label,
      );
      expect(refreshed).toBe(header);
      expect(refreshed?.querySelector("button")).toBe(button);
      expect(document.activeElement).toBe(button);
      expect(header?.getAttribute("aria-sort")).toBe(
        firstDirection === "asc" ? "ascending" : "descending",
      );
      header!.click();
      expect(onSortChange).toHaveBeenCalledTimes(initialCallCount + 2);
      expect(onSortChange).toHaveBeenLastCalledWith(
        column,
        firstDirection === "asc" ? "desc" : "asc",
      );
      expect(document.activeElement).toBe(button);
      expect(header?.getAttribute("aria-sort")).toBe(
        firstDirection === "asc" ? "descending" : "ascending",
      );
      expect(queryAll("thead th[data-sortable]")).toHaveLength(2);
      expect(queryAll("thead th[aria-sort]")).toHaveLength(1);
    }
  });

  it("uses the stored face for generic session links", async () => {
    await renderSettled(
      createRow("agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef", {
        boardFace: "dashboard",
        updatedAt: 1,
      }),
    );

    expect(container.querySelector<HTMLAnchorElement>(".session-link")?.getAttribute("href")).toBe(
      "/dashboard/main/1234567890abcdef1234567890abcdef",
    );
  });

  it("paginates grouped sessions while preserving full group counts", async () => {
    const onPageChange = vi.fn();
    const result = buildMultiResult([
      { key: "agent:main:discord:channel:1", kind: "group", updatedAt: 3 },
      createRow("agent:main:telegram:direct:2", { updatedAt: 2 }),
      { key: "agent:main:discord:channel:3", kind: "group", updatedAt: 1 },
    ]);
    await renderSettled(result, { groupBy: "channel", pageSize: 2, onPageChange });

    expect(texts(".session-group-row__label")).toEqual(["discord"]);
    expect(texts(".session-group-row__count")).toEqual(["2 sessions"]);
    expect(queryAll(".session-data-row")).toHaveLength(2);
    expect(container.querySelector(".data-table-pagination")?.textContent).toContain(
      "1-2 of 3 rows",
    );

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

  it.each([
    ["profile-ada", "Ada Lovelace", "Ada Lovelace"],
    ["gateway-owner", "Saved owner name", "Shared owner"],
  ])("offers person grouping and labels the durable profile %s", async (id, name, expected) => {
    await renderSettled(
      [
        createRow("agent:main:ada", {
          updatedAt: 2,
          owner: {
            actor: {
              type: "human",
              id,
              label: name,
              identity: { type: "profile", id },
            },
          },
        }),
        createRow("agent:main:ownerless", { updatedAt: 1 }),
      ],
      { groupBy: "person" },
    );

    expect(
      container
        .querySelector<HTMLOptionElement>('.session-groupby__select option[value="person"]')
        ?.textContent?.trim(),
    ).toBe("Person");
    expect(texts(".session-group-row__label")).toEqual([expected, "Ungrouped"]);
  });

  it("opens the session menu from the kebab and row context-menu shortcuts", async () => {
    const onOpenSessionMenu = vi.fn();
    const session = {
      key: "agent:main:dashboard:1",
      kind: "direct",
      updatedAt: Date.now(),
    } as const;
    await renderSettled(session, { onOpenSessionMenu });

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open session menu"]',
    );
    if (!button) {
      throw new Error("Expected session menu button");
    }
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    const expectMenuCall = (call: number, x: number, y: number, trigger: Element | null) =>
      expect(onOpenSessionMenu).toHaveBeenNthCalledWith(
        call,
        expect.objectContaining({ key: session.key }),
        { x, y },
        trigger,
      );
    button.click();
    expectMenuCall(1, expect.any(Number), expect.any(Number), button);
    const row = container.querySelector(".session-data-row");
    if (!row) {
      throw new Error("Expected session row");
    }
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
    expectMenuCall(3, expect.any(Number), expect.any(Number), button);
    expect(keyboardContextMenu.defaultPrevented).toBe(true);
  });

  it("keeps pinned sessions above newer unpinned sessions", async () => {
    await renderSettled([
      createRow("newer", { updatedAt: 200 }),
      createRow("pinned", { updatedAt: 100, pinned: true, pinnedAt: 300 }),
    ]);

    const keys = Array.from(queryAll("tbody .session-data-row")).map((row) =>
      row.querySelector(".session-key-cell__primary")?.textContent?.trim(),
    );
    expect(keys).toEqual(["pinned", "newer"]);
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

    const actions = container.querySelector(".settings-section__actions");
    const trigger = actions?.querySelector<HTMLButtonElement>(".sessions-filter-popover__trigger");
    const popover = actions?.querySelector(".sessions-filter-popover");
    const panel = popover?.querySelector(".sessions-filter-popover__panel");
    expect(queryAll(".sessions-filter-bar, .settings-count")).toHaveLength(0);
    expect(panel?.querySelector(".sessions-view-segment")).not.toBeNull();
    expect(panel?.querySelector(".sessions-filter-popover__search input")).not.toBeNull();
    expect(trigger?.textContent?.trim()).toBe("");
    expect(trigger?.getAttribute("aria-label")).toBe("Filters");
    expect(trigger?.getAttribute("title")).toBeNull();
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.querySelector(".session-filter-input--minutes")?.closest("label")).not.toBeNull();
    expect(panel?.querySelector(".session-filter-input--limit")?.closest("label")).not.toBeNull();
    expect(panel?.querySelector(".session-groupby__select")).not.toBeNull();

    const toggleGroup = panel?.querySelector(".session-filter-toggle-group");
    expect(toggleGroup?.getAttribute("role")).toBe("group");
    expect(toggleGroup?.getAttribute("aria-label")).toBe("Session source filters");
    expect(toggleGroup?.querySelectorAll(".session-filter-check")).toHaveLength(2);
    expect(
      Array.from(toggleGroup?.querySelectorAll(".session-filter-check") ?? []).map((toggle) => [
        toggle.querySelector("input")?.getAttribute("name"),
        [...toggle.classList],
      ]),
    ).toEqual([
      [
        "includeGlobal",
        ["session-filter-check", "session-filter-toggle", "session-filter-check--active"],
      ],
      ["includeUnknown", ["session-filter-check", "session-filter-toggle"]],
    ]);
    expect(toggleGroup?.querySelector(".session-filter-check__box")).toBeNull();

    trigger?.click();
    expect(popover?.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(popover);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    popover?.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(
      container.querySelector<HTMLInputElement>(".sessions-filter-popover__search input")?.value,
    ).toBe("keep me");
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  it.each(["provider-owned", "legacy binary"])(
    "renders and patches %s thinking ids",
    async (mode) => {
      const binary = mode === "legacy binary";
      const onPatch = vi.fn();
      await renderSettled(
        mainSession(
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
        ),
        { expandedSessionKey: "agent:main:main", onPatch },
      );
      const thinking = container.querySelector<HTMLSelectElement>("tbody select");
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
      thinking!.value = value;
      thinking!.dispatchEvent(new Event("change", { bubbles: true }));
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

    const keyCell = container.querySelector(".session-key-cell");
    expect(text(".session-key-cell__primary", keyCell)).toBe("📊 Data Expert (dingtalk)");
    expect((keyCell?.parentElement as (HTMLElement & { content: string }) | null)?.content).toBe(
      "📊 Data Expert (dingtalk)",
    );
  });

  it("keeps run metadata in session details instead of extra table columns", async () => {
    await renderSettled(
      [
        createRow("agent:main:queued", { updatedAt: 40, hasActiveRun: true, status: "queued" }),
        createRow("agent:main:idle", {
          unread: true,
          totalTokens: 300,
          updatedAt: 20,
          hasActiveRun: false,
          status: "running",
        }),
      ],
      { expandedSessionKey: "agent:main:queued" },
    );

    expect(sessionTableHeaders()).toEqual(SESSION_TABLE_HEADERS);
    expect(queryAll(".session-data-row .settings-status")).toHaveLength(0);
    expect(queryAll(".settings-count, .sessions-heading-fact")).toHaveLength(0);
    expect(container.querySelector(".session-details-panel__badges")?.textContent).toContain(
      "Queued",
    );
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
    expect(container.querySelector(".session-token-cell")).toBeNull();
  });

  it("renders expanded session details without checkpoint actions", async () => {
    await renderSettled(
      mainSession({
        totalTokens: 123456,
        contextTokens: 200000,
        model: "gpt-5.5",
        modelProvider: "openai",
        status: "running",
        runtimeMs: 125000,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "Finish the compaction details",
          status: "blocked",
          createdAt: 1,
          updatedAt: 2,
          tokenStart: 1000,
          tokensUsed: 24_000,
          continuationTurns: 3,
          lastStatusNote: "Waiting for owner review",
          blockedAt: 3,
        },
      }),
      {
        expandedSessionKey: "agent:main:main",
        patchAdminDisabledReason: "Operator admin access is required.",
      },
    );

    expect(container.querySelector(".session-token-cell")).toBeNull();
    const details = container.querySelector(".session-details-panel");
    expect(text(".session-details-panel__eyebrow", details)).toBe("Session details");
    expect(text(".session-details-panel__title", details)).toBe("agent:main:main");
    expect(
      Array.from(details?.querySelectorAll(".session-details-panel__badges > *") ?? []).map(
        (badge) => badge.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Live", "Goal blocked (24k used)", "direct"]);

    const stats = readSessionDetailStats(details ?? container);
    expect(Object.fromEntries(stats)).toMatchObject({
      Status: "running",
      Model: "gpt-5.5",
      Provider: "openai",
      Runtime: "-",
      "Run duration": "2m 5s",
      Tokens: "123456 / 200000",
      Goal: "Goal blocked (24k used): Finish the compaction details - Waiting for owner review",
      "Goal note": "Waiting for owner review",
    });
    expect(stats.has("Compaction")).toBe(false);

    const sections = Array.from(details?.querySelectorAll(".session-details-section") ?? []);
    expect(sections).toHaveLength(1);
    const [overridesSection] = sections;
    expect(text(".session-details-panel__eyebrow", overridesSection)).toBe("Overrides");
    expect(
      Array.from(overridesSection?.querySelectorAll(".session-override-field__label") ?? []).map(
        (label) => label.textContent?.trim(),
      ),
    ).toEqual(["Label", "Thinking", "Fast", "Verbose", "Reasoning"]);
    for (const select of overridesSection?.querySelectorAll<HTMLSelectElement>(
      ".session-override-field select",
    ) ?? []) {
      expect(select).toMatchObject({ disabled: true, title: "Operator admin access is required." });
    }
  });

  it("keeps session selects stable and deselects only the current page", async () => {
    const initial = buildResult(
      mainSession({ fastMode: true, verboseLevel: "full", reasoningLevel: "custom-mode" }),
    );
    await renderSettled(initial, { expandedSessionKey: "agent:main:main" });

    // Scope to drawer selects; the toolbar also renders a group-by select.
    const selects = queryAll("tbody select");
    const fast = selects[1] as HTMLSelectElement | undefined;
    const verbose = selects[2] as HTMLSelectElement | undefined;
    const reasoning = selects[3] as HTMLSelectElement | undefined;
    expect(fast?.value).toBe("on");
    expect(verbose?.value).toBe("full");
    expect(optionValues(verbose)).toEqual(["", "off", "on", "full"]);
    expect(reasoning?.value).toBe("custom-mode");
    expect(optionValues(reasoning)).toEqual(["", "off", "on", "stream", "custom-mode"]);

    document.body.append(container);
    fast!.focus();
    fast!.value = "off";
    renderView(
      { ...initial, sessions: [{ ...initial.sessions[0]!, updatedAt: Date.now() + 1 }] },
      { expandedSessionKey: "agent:main:main" },
    );
    const refreshed = queryAll("tbody select");
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

    const headerCheckbox = container.querySelector<HTMLInputElement>("thead input[type=checkbox]");
    expect(headerCheckbox).toBeInstanceOf(HTMLInputElement);
    headerCheckbox!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onDeselectPage).toHaveBeenCalledWith(["page-0"]);
    expect(onDeselectAll).not.toHaveBeenCalled();
    expect(onSelectPage).not.toHaveBeenCalled();
  });

  it("omits the kind glyph while preserving kind details", async () => {
    await renderSettled(
      [
        createRow("agent:main:cron:live", { updatedAt: 2, hasActiveRun: true, status: "running" }),
        createRow("agent:main:idle", { updatedAt: 1, hasActiveRun: false }),
      ],
      { expandedSessionKey: "agent:main:cron:live" },
    );

    expect(text(".session-kind--cron")).toBe("cron");
    expect(container.querySelector(".session-data-row .session-avatar")).toBeNull();
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

    expect(texts(".session-group-row__label")).toEqual([category, "Ungrouped"]);

    // The populated category renders before the ungrouped row.
    const select = queryAll<HTMLSelectElement>('select[aria-label="Move session to a group"]')[1];
    if (!select) {
      throw new Error("Expected group select");
    }
    select.value = category;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onAssignCategory).toHaveBeenCalledWith("agent:main:discord:channel:1", category);

    select.selectedIndex = select.options.length - 1;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onRequestNewCategory).toHaveBeenCalledWith("agent:main:discord:channel:1");
    expect(select.value).toBe("");

    const headerRow = container.querySelector(".session-group-row");
    if (!headerRow) {
      throw new Error("Expected group header row");
    }
    const dropWithPayload = (types: string[], data: Record<string, string>) => {
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", {
        value: { types, getData: (type: string) => data[type] ?? "" },
      });
      headerRow.dispatchEvent(drop);
    };

    // Generic text drags (e.g. selected page text) must not trigger patches.
    dropWithPayload(["text/plain"], { "text/plain": "not-a-session" });
    expect(onAssignCategory).toHaveBeenCalledTimes(1);

    dropWithPayload(["application/x-openclaw-session-key"], {
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

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Move session to a group"]',
    );
    expect(select).toMatchObject({ disabled: true, title: reason });
    if (select) {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const headerRow = container.querySelector(".session-group-row");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["application/x-openclaw-session-key"],
        getData: () => "agent:main:main",
      },
    });
    headerRow?.dispatchEvent(drop);

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
  fast.value = "off";
  fast.dispatchEvent(new Event("change"));
  expect(onPatch).toHaveBeenCalledWith(key, { fastMode: false });
});
