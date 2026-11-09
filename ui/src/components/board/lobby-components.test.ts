import { afterEach, expect, it, vi } from "vitest";
import { boardWidget, callbacks, mount, settleCells, snapshot } from "./board-view.test-support.ts";
import { cleanupCells } from "./board-widget-cell.test-support.ts";
import "./board-view.tsx";

afterEach(cleanupCells);

it("uses readable inline Lobby approval details without changing grant authority", async () => {
  const actions = callbacks();
  const description = "Move the pointer on the approved display without clicks or keys.";
  const view = await mount({
    canGrant: false,
    callbacks: actions,
    snapshot: snapshot({
      widgets: [
        boardWidget({
          name: "pointer",
          grantState: "pending",
          declared: {
            actionBindings: [
              {
                name: "move-pointer",
                actionId: "device-controls.pointer",
                params: { nodeId: "studio-mac", operation: "move", referenceWidth: 1920 },
              },
            ],
          },
          capabilityDescriptions: { "device-controls.pointer": description },
        }),
      ],
    }),
  });
  view.lobby = true;
  await settleCells(view);
  view.querySelector<HTMLButtonElement>(".lobby-component__toggle")!.click();
  await settleCells(view);
  const pending = view.querySelector('[data-test-id="board-pending"]')!;
  expect(pending.querySelector(".lobby-access__requests")).not.toBeNull();
  expect(pending.textContent).toContain(description);
  expect(pending.querySelector("details")?.open).toBe(false);
  expect([...pending.querySelectorAll("dd")].map((entry) => entry.textContent)).toEqual([
    "device-controls.pointer",
    "studio-mac",
    "move",
    "1920",
  ]);
  expect(pending.querySelector(".board-widget__grant-groups")).toBeNull();
  const allow = pending.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]')!;
  expect(allow.disabled).toBe(true);
  allow.click();
  await settleCells(view);
  expect(actions.grant).not.toHaveBeenCalled();
  view.canGrant = true;
  await settleCells(view);
  expect(allow.disabled).toBe(false);
  allow.click();
  await settleCells(view);
  expect(actions.grant).toHaveBeenCalledExactlyOnceWith("pointer", "granted");
  view.lobby = false;
  await settleCells(view);
  expect(view.querySelector(".lobby-access__requests")).toBeNull();
  expect(view.querySelector(".board-widget__grant-groups")?.textContent).toContain("studio-mac");
});

it("presents all Lobby tabs as one ordered collection without changing the board", async () => {
  const handlers = callbacks();
  const initial = snapshot({
    widgets: [
      boardWidget({ name: "third", tabId: "ops", position: 0 }),
      boardWidget({ name: "second", position: 1 }),
      boardWidget({ name: "first", position: 0 }),
    ],
  });
  const view = await mount({ snapshot: initial, callbacks: handlers });
  expect(view.querySelector(".board-tabs")).not.toBeNull();
  expect(view.querySelectorAll("openclaw-board-widget-cell:not([hidden])")).toHaveLength(2);

  view.lobby = true;
  await settleCells(view);
  expect(view.querySelector(".board-tabs")).toBeNull();
  const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
  expect(cells).toHaveLength(3);
  const byName = new Map(cells.map((cell) => [cell.widget!.name, cell]));
  for (const [index, name] of ["first", "second", "third"].entries()) {
    const cell = byName.get(name)!;
    expect(cell.hidden).toBe(false);
    expect(cell.active).toBe(true);
    expect(cell.positionInSet).toBe(index + 1);
    expect(cell.setSize).toBe(3);
  }

  const frames = cells.map((cell) => cell.querySelector("iframe"));
  view.activeTabId = "ops";
  await settleCells(view);
  expect(cells.map((cell) => cell.querySelector("iframe"))).toEqual(frames);
  expect(cells.every((cell) => !cell.hidden && cell.active)).toBe(true);
  expect(view.snapshot).toBe(initial);
  expect(handlers.applyOps).not.toHaveBeenCalled();
  expect(handlers.selectTab).not.toHaveBeenCalled();

  view.lobby = false;
  await settleCells(view);
  expect(view.querySelector(".board-tabs")).not.toBeNull();
  expect(view.querySelectorAll("openclaw-board-widget-cell:not([hidden])")).toHaveLength(1);
  expect(byName.get("third")!.hidden).toBe(false);
  expect(byName.get("first")!.hidden).toBe(true);
});

it("opens a component page and returns to the same live preview without layout writes", async () => {
  const applyOps = vi.fn(async () => undefined);
  const initial = snapshot({ widgets: [boardWidget({ frameUrl: "/clock" })] });
  const view = await mount({ snapshot: initial, callbacks: callbacks({ applyOps }) });
  view.lobby = true;
  await settleCells(view);
  const frame = view.querySelector("iframe");
  expect(frame).not.toBeNull();
  const source = frame!.getAttribute("src");
  const toggle = view.querySelector<HTMLButtonElement>(".lobby-component__toggle")!;
  expect(toggle.getAttribute("aria-label")).toBe("Open Alpha status");
  expect(view.querySelector("iframe")).toBe(frame);
  expect(frame!.getAttribute("src")).toBe(source);
  expect(view.querySelector(".board-widget__body")?.hasAttribute("inert")).toBe(true);
  expect(view.querySelector(".lobby-component__preview-slot")).not.toBeNull();
  expect(view.querySelector(".board-widget__kind")).toBeNull();
  expect(view.querySelector(".board-widget__drag-handle")).toBeNull();
  expect(view.querySelector(".board-widget__resize-handle")).toBeNull();
  expect(view.querySelector(".board-widget__menu-trigger")).toBeNull();
  view.snapshot = {
    ...initial,
    revision: 2,
    widgets: [{ ...initial.widgets[0]!, title: "My clock" }],
  };
  await settleCells(view);
  expect(toggle.getAttribute("aria-label")).toBe("Open My clock");
  toggle.click();
  await settleCells(view);
  expect(view.querySelector("iframe")).toBe(frame);
  expect(view.querySelector(".board-widget__body")?.hasAttribute("inert")).toBe(false);
  expect(toggle.getAttribute("aria-label")).toBe("Back to Lobby");
  toggle.click();
  await settleCells(view);
  expect(view.querySelector("iframe")).toBe(frame);
  expect(view.querySelector(".board-widget__body")?.hasAttribute("inert")).toBe(true);
  expect(applyOps).not.toHaveBeenCalled();
});

it("ignores saved grid height while retaining the agent's component order", async () => {
  const view = await mount({
    snapshot: snapshot({
      widgets: [
        boardWidget({ name: "text", sizeH: 1 }),
        boardWidget({ name: "clock", sizeH: 8, position: 1 }),
      ],
    }),
  });
  view.lobby = true;
  await settleCells(view);
  const cards = [...view.querySelectorAll<HTMLElement>(".board-widget")];
  expect(cards[0]!.style.height).toBe("98px");
  expect(cards[1]!.style.height).toBe("98px");
  expect(cards[0]!.style.getPropertyValue("--lobby-source-side")).toBe(
    cards[1]!.style.getPropertyValue("--lobby-source-side"),
  );
  view.snapshot = snapshot({
    revision: 2,
    widgets: [
      boardWidget({ name: "text", sizeH: 1, position: 1 }),
      boardWidget({ name: "clock", sizeH: 8, position: 0 }),
    ],
  });
  await settleCells(view);
  expect(cards[0]!.style.order).toBe("2");
  expect(cards[1]!.style.order).toBe("1");
});

it("shows only the creation prompt when the Lobby has no components", async () => {
  const view = await mount({ snapshot: snapshot({ tabs: [], widgets: [] }) });
  view.lobby = true;
  await settleCells(view);
  expect(view.querySelector(".board-empty")?.textContent?.trim()).toBe(
    "Ask your agent to create something for you here.",
  );
  expect(view.querySelector(".board-empty__mark")).toBeNull();
  expect(view.querySelector(".board-empty strong")).toBeNull();
});

it("keeps Lobby menu mutations unavailable while the standard dashboard keeps its menu", async () => {
  const applyOps = vi.fn(async () => undefined);
  const view = await mount({
    snapshot: snapshot({ widgets: [boardWidget()] }),
    callbacks: callbacks({ applyOps }),
  });
  await settleCells(view);
  expect(view.querySelector(".board-widget__menu-trigger")).not.toBeNull();
  view.lobby = true;
  await settleCells(view);
  const cell = view.querySelector("openclaw-board-widget-cell")!;
  for (const action of ["height:auto", "height:change", "resize:sm", "remove", "move:elsewhere"]) {
    cell.selectMenuItem(action);
  }
  await settleCells(view);
  expect(view.querySelector(".board-widget__menu-trigger")).toBeNull();
  expect(view.querySelector(".lobby-component__height-handle")).toBeNull();
  expect(applyOps).not.toHaveBeenCalled();
});

it("shows only the selected component and falls back to the list when it is removed", async () => {
  const initial = snapshot({
    widgets: [boardWidget({ name: "first" }), boardWidget({ name: "second", position: 1 })],
  });
  const view = await mount({ snapshot: initial, callbacks: callbacks() });
  view.lobby = true;
  await settleCells(view);
  const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
  const frames = cells.map((cell) => cell.querySelector("iframe"));
  cells[1]!.querySelector<HTMLButtonElement>(".lobby-component__toggle")!.click();
  await settleCells(view);
  expect(cells[0]!.hidden).toBe(true);
  expect(cells[0]!.active).toBe(false);
  expect(cells[1]!.hidden).toBe(false);
  expect(cells[1]!.lobbyPage).toBe(true);
  expect(cells[1]!.positionInSet).toBe(1);
  expect(cells[1]!.setSize).toBe(1);
  expect(cells.map((cell) => cell.querySelector("iframe"))).toEqual(frames);
  view.snapshot = { ...initial, revision: 2, widgets: [initial.widgets[0]!] };
  await settleCells(view);
  expect(cells[0]!.hidden).toBe(false);
  expect(cells[0]!.lobbyPage).toBe(false);
});
