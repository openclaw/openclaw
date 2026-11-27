/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { beginUiLeakCheck } from "../../test-helpers/unit-leak-guard.ts";
import {
  eventGateway,
  mountPanel,
  panelTestStorage,
} from "./terminal-panel-lifecycle.test-support.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const tag = defineTestTerminalPanelElement(createTerminal);
panelTestStorage(createTerminal);

it("removes resize listeners when disconnected mid-drag", async () => {
  createTerminal.mockResolvedValue(createTerminalController());
  const { client } = eventGateway((method) =>
    method === "terminal.open" ? terminalOpenResult("session-1") : { ok: true },
  );
  const panel = mountPanel(tag, { client, available: true }, false);
  panel.toggle();
  await panel.updateComplete;

  const checkLeaks = beginUiLeakCheck();
  panel
    .querySelector(".tp-resizer")
    ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 200 }));
  expect(checkLeaks()).toContain("window listener pointermove");
  panel.remove();
  await Promise.resolve();
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 20, clientY: 20 }));

  expect(checkLeaks().filter((leak) => leak.startsWith("window listener "))).toEqual([]);
  expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-bottom")).toBe(
    "0px",
  );
  expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right")).toBe(
    "0px",
  );
});
