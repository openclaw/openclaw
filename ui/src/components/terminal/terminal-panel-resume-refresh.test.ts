/* @vitest-environment jsdom */

import type { TerminalAttachResult } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { refreshControlUiServiceWorker } from "../../app/sw-refresh.runtime.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { panelFixture, togglePanel } from "./terminal-panel-lifecycle.test-support.ts";
import { createTerminalController, terminalOpenResult } from "./terminal-panel.test-support.ts";

vi.mock("../../app/sw-refresh.runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/sw-refresh.runtime.ts")>()),
  refreshControlUiServiceWorker: vi.fn(),
}));

const fixture = panelFixture(
  false,
  () => {
    vi.restoreAllMocks();
    vi.mocked(refreshControlUiServiceWorker).mockReset();
  },
  false,
);
const createGhosttyTerminalMock = fixture.create;

function mount(request: ReturnType<typeof createGatewayRequestMock>) {
  return fixture.mount({ client: createTestGatewayClient(request) });
}

const savedIds = () => sessionStorage.getItem("openclaw.terminal.sessions.v1");

it("settles availability changes while offline without repeatedly suspending the terminal", async () => {
  const terminal = createTerminalController();
  createGhosttyTerminalMock.mockResolvedValue(terminal);
  const request = createGatewayRequestMock((method) =>
    method === "terminal.open" ? terminalOpenResult("retained") : { ok: true },
  );
  const panel = mount(request);
  await waitForFast(() => expect(savedIds()).toBe('["retained"]'));
  panel.gatewayConnected = false;
  await panel.updateComplete;
  await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenCalledWith(true));
  await panel.updateComplete;
  expect(terminal.dispose).not.toHaveBeenCalled();

  request.mockClear();

  for (const available of [false, true]) {
    panel.available = available;
    await panel.updateComplete;
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(panel).toMatchObject({ hostedTabs: [], terminalPanelOpen: available });
    expect(panel.querySelector(".tp") !== null).toBe(available);
    expect(request).not.toHaveBeenCalled();
  }
});

it("holds retained PTYs and queued actions behind the same-client reconnect refresh", async () => {
  const refresh = createDeferred<boolean>();
  const reattach = createDeferred<TerminalAttachResult>();
  const terminal = createTerminalController();
  vi.mocked(refreshControlUiServiceWorker).mockReturnValue(refresh.promise);
  createGhosttyTerminalMock
    .mockImplementation(async () => createTerminalController())
    .mockResolvedValueOnce(terminal);
  let opened = 0;
  const request = createGatewayRequestMock((method) => {
    if (method === "terminal.open") {
      return terminalOpenResult(++opened === 1 ? "retained" : "queued");
    }
    if (method === "terminal.attach") {
      return reattach.promise;
    }
    return { ok: true };
  });
  const panel = mount(request);
  await waitForFast(() => expect(savedIds()).toBe('["retained"]'));
  const tabId = panel.hostedTabs[0]!.id;
  const terminalHost = createGhosttyTerminalMock.mock.calls[0]![0].parent;

  panel.gatewayConnected = false;
  await panel.updateComplete;
  await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenCalledWith(true));
  togglePanel(panel, { open: true, newSession: true });
  await panel.updateComplete;
  expect(opened).toBe(1);

  panel.gatewayConnected = true;
  await panel.updateComplete;
  await waitForFast(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
  expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toEqual([]);
  expect(opened).toBe(1);
  expect(panel.hostedTabs.map((tab) => tab.id)).toEqual([tabId]);
  expect(terminal.dispose).not.toHaveBeenCalled();

  refresh.resolve(false);
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toHaveLength(1),
  );
  expect(opened).toBe(1);
  expect(terminal.setReadOnly).toHaveBeenLastCalledWith(true);
  reattach.resolve({ ...terminalOpenResult("retained"), buffer: "", seq: 0 });
  await waitForFast(() => {
    expect(savedIds()).toBe('["retained","queued"]');
    expect(terminal.setReadOnly).toHaveBeenLastCalledWith(false);
  });
  expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toHaveLength(1);
  expect(opened).toBe(2);
  expect(panel.hostedTabs[0]?.id).toBe(tabId);
  expect(panel.contains(terminalHost)).toBe(true);
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(panel.querySelector(".tp-error")).toBeNull();
});

it("exits a confirmed missing retained PTY without leaving its surviving tab read-only", async () => {
  vi.mocked(refreshControlUiServiceWorker).mockResolvedValue(false);
  const expiredTerminal = createTerminalController();
  const survivingTerminal = createTerminalController();
  createGhosttyTerminalMock
    .mockResolvedValueOnce(expiredTerminal)
    .mockResolvedValueOnce(survivingTerminal);
  let opened = 0;
  const request = createGatewayRequestMock((method, params) => {
    if (method === "terminal.open") {
      return terminalOpenResult(++opened === 1 ? "expired" : "survivor");
    }
    if (method === "terminal.attach") {
      return isRecord(params) && params.sessionId === "expired"
        ? Promise.reject(new Error('unknown terminal session "expired"'))
        : { ...terminalOpenResult("survivor"), buffer: "", seq: 0 };
    }
    if (method === "terminal.list") {
      return { sessions: [{ ...terminalOpenResult("survivor"), attached: true, createdAtMs: 1 }] };
    }
    return { ok: true };
  });
  const panel = mount(request);
  await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
  panel.querySelector<HTMLButtonElement>('[aria-label="New terminal session"]')!.click();
  await panel.updateComplete;
  await waitForFast(() => expect(panel.hostedTabs[1]?.className).toBe("is-live"));
  const tabIds = panel.hostedTabs.map((tab) => tab.id);
  expect(savedIds()).toBe('["expired","survivor"]');

  panel.gatewayConnected = false;
  await panel.updateComplete;
  await waitForFast(() => {
    expect(expiredTerminal.setReadOnly).toHaveBeenLastCalledWith(true);
    expect(survivingTerminal.setReadOnly).toHaveBeenLastCalledWith(true);
  });
  panel.gatewayConnected = true;
  await panel.updateComplete;
  await waitForFast(() => {
    expect(survivingTerminal.setReadOnly).toHaveBeenLastCalledWith(false);
    expect(panel.hostedTabs.map((tab) => tab.className)).toEqual(["is-exited", "is-live"]);
  });
  expect(expiredTerminal.setReadOnly).toHaveBeenLastCalledWith(true);
  expect(panel.hostedTabs.map((tab) => tab.id)).toEqual(tabIds);
  expect(expiredTerminal.dispose).not.toHaveBeenCalled();
  expect(survivingTerminal.dispose).not.toHaveBeenCalled();
  expect(savedIds()).toBe('["survivor"]');
  expect(panel.querySelector(".tp-error")).toBeNull();
});
