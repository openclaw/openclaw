/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { TerminalConnection, type TerminalGatewayClient } from "./terminal-connection.ts";
import { updateTerminalFont } from "./terminal-fonts.ts";
import { bootTerminalPanelSession } from "./terminal-panel-session-boot.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalPanelControllerForTest,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

const create: CreateGhosttyTerminalMock = vi.fn();
const tag = defineTestTerminalPanelElement(create);

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.useRealTimers();
  create.mockReset();
});

it("adopts the newest font after asynchronous recovery without another panel render", async () => {
  const original = createTerminalController();
  const replacement = createTerminalController();
  const creating = createDeferred();
  const created = createDeferred<typeof replacement>();
  let family = '"Original Font"';
  create.mockImplementation(async (options) => {
    const controller = create.mock.calls.length === 1 ? original : replacement;
    controller.terminal.options.fontFamily = options.terminalOptions!.fontFamily!;
    if (controller === replacement) {
      creating.resolve();
      return created.promise;
    }
    return controller;
  });
  const panel = createTestTerminalPanel(tag);
  document.body.append(panel);
  await panel.updateComplete;
  const viewport = document.body.appendChild(document.createElement("div"));
  const controller = terminalPanelControllerForTest(panel);
  vi.spyOn(controller, "findTerminalPanelViewport").mockReturnValue(viewport);
  vi.spyOn(controller, "terminalFontFamily", "get").mockImplementation(() => family);
  const client: TerminalGatewayClient = {
    forceReconnect: vi.fn(),
    request: vi.fn(),
    addEventListener: () => () => {},
  };
  const connection = new TerminalConnection(client);
  const signal = new AbortController().signal;
  const boot = await bootTerminalPanelSession({
    panel: controller,
    connection,
    sequence: 1,
    awaitFirstOutput: false,
    isCurrent: () => true,
    onReady: vi.fn(),
    onExit: vi.fn(),
  });
  boot.tab.status = "live";
  vi.useFakeTimers();
  const recovering = boot.sink.onReplay!({
    data: "replayed prompt",
    newlyObservedFrom: 0,
    mode: "recovery",
    signal,
  });
  await creating.promise;
  family = '"New Font"';
  updateTerminalFont(boot.tab.controller, family);
  expect(original.terminal.options.fontFamily).toBe(family);
  // Replay precedes the replacement's deferred publication. A preference
  // changed here must also beat the font captured at renderer creation.
  replacement.write.mockImplementation(() => {
    family = '"Newest Font"';
  });
  created.resolve(replacement);
  await vi.runAllTimersAsync();
  await recovering;
  expect(boot.tab.controller).toBe(replacement);
  expect(replacement.terminal.options.fontFamily).toBe(family);
  expect(original.dispose).toHaveBeenCalledOnce();
  expect(replacement.fit).toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(2);
  boot.tab.controller.dispose();
});
