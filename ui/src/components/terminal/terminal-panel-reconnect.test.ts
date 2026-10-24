/* @vitest-environment jsdom */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { refreshControlUiServiceWorker } from "../../app/sw-refresh.runtime.ts";
import { i18n } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

vi.mock("../../app/sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);

describe("OpenClawTerminalPanel reconnect", () => {
  beforeAll(async () => {
    // Load the real responder before short RPC assertions begin on a cold worker.
    await import("@openclaw/libterminal/browser");
  });

  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    vi.useRealTimers();
    document.body.replaceChildren();
    await Promise.resolve();
    createGhosttyTerminalMock.mockReset();
    vi.mocked(refreshControlUiServiceWorker).mockReset();
    vi.mocked(refreshControlUiServiceWorker).mockResolvedValue(false);
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("finishes a catalog request persisted by v2026.9.4 exactly once", async () => {
    const catalog = { catalogId: "codex", hostId: "gateway:local", threadId: "pending-upgrade" };
    sessionStorage.setItem(
      "openclaw.terminal.actions.v1",
      JSON.stringify([{ kind: "catalog", agentId: "ops", catalog }]),
    );
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
    );
    createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return (
          method === "terminal.open" ? terminalOpenResult("upgraded-session") : { ok: true }
        ) as T;
      },
      addEventListener: () => () => {},
    };
    const mountPanel = () => {
      const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
      panel.client = client;
      panel.available = true;
      document.body.append(panel);
      return panel;
    };
    const panel = mountPanel();
    await panel.updateComplete;
    await vi.dynamicImportSettled();
    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.open",
        params: { agentId: "ops", cols: 100, rows: 30, catalog },
      });
      expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull();
    });

    panel.remove();
    mountPanel();
    await vi.dynamicImportSettled();
    await waitForFast(() => {
      expect(requests.filter(({ method }) => method === "terminal.open")).toHaveLength(2);
    });
    expect(
      requests.filter(
        ({ params }) => typeof params === "object" && params !== null && "catalog" in params,
      ),
    ).toHaveLength(1);
  });

  it("retains the terminal, selected tab, and upload across a transport blip but retires them on identity change", async () => {
    const terminal = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(terminal);
    let listener: Parameters<TerminalGatewayClient["addEventListener"]>[0] | undefined;
    let failedAttach = false;
    const request = vi.fn((method: string) => {
      if (method === "terminal.open") {
        return Promise.resolve(terminalOpenResult("retained"));
      }
      if (method === "terminal.attach") {
        if (!failedAttach) {
          failedAttach = true;
          return Promise.reject(new Error("temporary attach failure"));
        }
        return Promise.resolve({
          ...terminalOpenResult("retained"),
          buffer: "beforeafter",
          seq: 11,
        });
      }
      if (method === "terminal.input") {
        return Promise.reject(new Error("input delivery interrupted"));
      }
      if (method === "terminal.list") {
        return Promise.resolve({
          sessions: [{ ...terminalOpenResult("retained"), attached: true, createdAtMs: 1 }],
        });
      }
      return Promise.resolve({ ok: true });
    });
    const client: TerminalGatewayClient = {
      forceReconnect: vi.fn(),
      recoveryScope: "account-a",
      request: <T>(method: string) => request(method) as Promise<T>,
      addEventListener: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await waitForFast(() =>
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe('["retained"]'),
    );
    const tabId = panel.hostedTabs[0]!.id;
    const activeId = panel.activeHostedTabId;
    listener?.({
      event: "terminal.data",
      payload: { sessionId: "retained", seq: 6, data: "before" },
    });
    const read = createDeferred<ArrayBuffer>();
    const file = new File(["pending"], "pending.txt");
    Object.defineProperty(file, "arrayBuffer", { value: () => read.promise });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    panel.querySelector(".tp-viewport")?.dispatchEvent(drop);
    await waitForFast(() => expect(panel.querySelector(".tp-upload-card")).not.toBeNull());

    panel.gatewayConnected = false;
    await panel.updateComplete;
    await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenCalledWith(true));
    expect(panel.terminalPanelOpen).toBe(true);
    expect(panel.hostedTabs[0]?.id).toBe(tabId);
    expect(panel.activeHostedTabId).toBe(activeId);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(panel.querySelector(".tp-upload-card--failed")).not.toBeNull();
    expect(panel.querySelector<HTMLButtonElement>(".tp-upload-retry")?.disabled).toBe(true);
    expect(panel.hostedTabs[0]?.closeDisabled).toBe(true);
    expect(panel.querySelector<HTMLButtonElement>(".tabstrip-tab__close")?.disabled).toBe(true);
    panel.querySelector(".tabstrip-tab")!.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
    await panel.closeHostedTab(tabId);
    expect(panel.hostedTabs[0]?.id).toBe(tabId);
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe('["retained"]');
    expect(request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
    createGhosttyTerminalMock.mock.calls[0]![0].onData?.(new TextEncoder().encode("do not replay"));
    read.resolve(new ArrayBuffer(1));
    await read.promise;

    panel.gatewayConnected = true;
    await panel.updateComplete;
    await waitForFast(() => expect(request).toHaveBeenCalledWith("terminal.attach"));
    await waitForFast(() => expect(panel.querySelector(".tp-error .btn")).not.toBeNull());
    expect(panel.hostedTabs[0]?.id).toBe(tabId);
    expect(terminal.setReadOnly).toHaveBeenLastCalledWith(true);
    panel.querySelector<HTMLButtonElement>(".tp-error .btn")!.click();
    await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenLastCalledWith(false));
    expect(panel.hostedTabs[0]?.id).toBe(tabId);
    expect(panel.activeHostedTabId).toBe(activeId);
    expect(createGhosttyTerminalMock).toHaveBeenCalledOnce();
    expect(panel.hostedTabs[0]?.closeDisabled).toBe(false);
    expect(terminal.write.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      "before",
      "after",
    ]);
    expect(request.mock.calls.some(([method]) => method === "terminal.input")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "terminal.upload")).toBe(false);
    await waitForFast(() => expect(panel.querySelector(".tp-upload-card")).not.toBeNull());

    createGhosttyTerminalMock.mock.calls[0]![0].onData?.(
      new TextEncoder().encode("after reconnect"),
    );
    await waitForFast(() =>
      expect(panel.querySelector(".tp-error")?.textContent).toContain(
        "Terminal delivery could not be confirmed",
      ),
    );

    Object.assign(client, { recoveryScope: "account-b" });
    panel.available = false;
    await panel.updateComplete;
    await waitForFast(() => expect(terminal.dispose).toHaveBeenCalledOnce());
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.querySelector(".tp-upload-card")).toBeNull();
  });

  it("retains the composed command and attachments until failed recovery is retried", async () => {
    vi.useFakeTimers();
    const terminal = createTerminalController();
    terminal.setReadOnly.mockImplementation((readOnly: boolean) => {
      terminal.readOnly = readOnly;
    });
    createGhosttyTerminalMock.mockImplementation(async (options) => {
      // The emulator emits bytes; the real startup-input owner admits or rejects them.
      terminal.terminal.paste.mockImplementation((text: string) => {
        options.onData?.(new TextEncoder().encode(text));
      });
      terminal.terminal.input.mockImplementation((text: string, wasUserInput: boolean) => {
        if (wasUserInput) {
          options.onData?.(new TextEncoder().encode(text));
        }
      });
      return terminal;
    });
    const recovered = { ...terminalOpenResult("retained"), buffer: "", seq: 0 };
    const recovery = createDeferred<typeof recovered>();
    let attachAttempts = 0;
    let opened = false;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "terminal.open") {
        opened = true;
        return terminalOpenResult("retained");
      }
      if (method === "terminal.attach") {
        return attachAttempts++ === 0 ? recovery.promise : recovered;
      }
      if (method === "terminal.list") {
        return {
          sessions: opened
            ? [{ ...terminalOpenResult("retained"), attached: true, createdAtMs: 1 }]
            : [],
        };
      }
      if (method === "terminal.upload") {
        return { path: "/tmp/notes.txt", size: 4 };
      }
      return { ok: true };
    });
    const client: TerminalGatewayClient = {
      forceReconnect: vi.fn(),
      // SAFETY: This Gateway fixture returns the response selected by the requested method.
      request: <T>(method: string, params?: unknown) => request(method, params) as Promise<T>,
      addEventListener: () => () => {},
    };
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.embedded = true;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    await panel.updateComplete;
    await vi.dynamicImportSettled();
    await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
    panel.selectHostedTab(panel.activeHostedTabId!);
    await panel.updateComplete;
    const input = panel.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!;
    input.value = "cat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const file = new File(["test"], "notes.txt");
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("test").buffer,
    });
    const fileInput = panel.querySelector<HTMLInputElement>(".tp-file-input")!;
    Object.defineProperty(fileInput, "files", { value: [file] });
    fileInput.dispatchEvent(new Event("change"));
    await waitForFast(() =>
      expect(panel.querySelector(".tp-attachment")?.textContent).toContain("notes.txt"),
    );

    panel.gatewayConnected = false;
    await panel.updateComplete;
    await waitForFast(() => expect(terminal.readOnly).toBe(true));
    panel.gatewayConnected = true;
    await panel.updateComplete;
    await waitForFast(() => expect(attachAttempts).toBe(1));
    const send = () =>
      panel.querySelector<HTMLButtonElement>('[aria-label="Send terminal input"]')!.click();
    const expectRetainedDraft = () => {
      expect(panel.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!.value).toBe(
        "cat",
      );
      expect(panel.querySelector(".tp-attachment")?.textContent).toContain("notes.txt");
      expect(request.mock.calls.filter(([method]) => method === "terminal.input")).toEqual([]);
    };
    send();
    await panel.updateComplete;
    expectRetainedDraft();

    recovery.reject(new Error("temporary attach failure"));
    await waitForFast(() =>
      expect(panel.querySelector(".tp-error")?.textContent).toContain(
        "Could not attach terminal session",
      ),
    );
    expect(panel.hostedTabs[0]?.className).toBe("is-live");
    expect(terminal.readOnly).toBe(true);
    send();
    await panel.updateComplete;
    expectRetainedDraft();
    expect(panel.querySelector(".tp-error")?.textContent).toContain(
      "Could not attach terminal session",
    );

    panel.querySelector<HTMLButtonElement>(".tp-error .btn")!.click();
    await waitForFast(() => expect(terminal.readOnly).toBe(false));
    expectRetainedDraft();
    send();
    await panel.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "terminal.input")).toEqual([
      ["terminal.input", { sessionId: "retained", data: "cat /tmp/notes.txt" }],
      ["terminal.input", { sessionId: "retained", data: "\r" }],
    ]);
    expect(panel.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!.value).toBe("");
    expect(panel.querySelector(".tp-attachment")).toBeNull();
  });

  it.each([
    ["input", false],
    ["resize", false],
    ["input", true],
    ["resize", true],
  ] as const)(
    "reports interrupted %s delivery only to its retained identity (replaced=%s)",
    async (action, replaced) => {
      const terminal = createTerminalController();
      createGhosttyTerminalMock.mockResolvedValue(terminal);
      const delivery = createDeferred<{ ok: boolean }>();
      const dispatched = createDeferred();
      let armed = false;
      const client = createTestGatewayClient((method) => {
        if (armed && method === `terminal.${action}`) {
          dispatched.resolve();
          return delivery.promise;
        }
        if (method === "terminal.attach") {
          return { ...terminalOpenResult("interrupted"), buffer: "", seq: 0 };
        }
        return method === "terminal.open" ? terminalOpenResult("interrupted") : { ok: true };
      });
      const recoveryScope = vi.spyOn(client, "recoveryScope", "get").mockReturnValue("account-a");
      vi.spyOn(client, "forceReconnect").mockImplementation(() => {});
      vi.spyOn(client, "addEventListener").mockReturnValue(() => {});
      const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
      panel.client = client;
      panel.available = true;
      document.body.append(panel);
      panel.toggle();
      await waitForFast(() =>
        expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe('["interrupted"]'),
      );
      await panel.updateComplete;
      const tabId = panel.hostedTabs[0]!.id;
      armed = true;
      const callbacks = createGhosttyTerminalMock.mock.calls[0]![0];
      if (action === "input") {
        callbacks.onData?.(new TextEncoder().encode("uncertain input"));
      } else {
        callbacks.onResize?.({ columns: 120, rows: 40 });
      }
      await dispatched.promise;

      panel.gatewayConnected = false;
      await panel.updateComplete;
      await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenCalledWith(true));
      if (replaced) {
        recoveryScope.mockReturnValue("account-b");
        panel.available = false;
        await panel.updateComplete;
        await waitForFast(() => expect(panel.hostedTabs).toEqual([]));
      }
      delivery.reject(new Error("connection lost"));
      await delivery.promise.catch(() => undefined);
      await panel.updateComplete;

      if (replaced) {
        expect(panel.querySelector(".tp-error")).toBeNull();
      } else {
        expect(panel.hostedTabs[0]?.id).toBe(tabId);
        await waitForFast(() =>
          expect(panel.querySelector('.tp-error[role="alert"]')?.textContent).toContain(
            "Terminal delivery could not be confirmed",
          ),
        );
        armed = false;
        panel.gatewayConnected = true;
        await panel.updateComplete;
        await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenLastCalledWith(false));
        await panel.updateComplete;
        expect(panel.hostedTabs[0]?.id).toBe(tabId);
        expect(panel.querySelector('.tp-error[role="alert"]')?.textContent).toContain(
          "Terminal delivery could not be confirmed",
        );
      }
    },
  );

  it.each(["agent:agent:main:background-task"] as const)(
    "attaches a %s session with its native title and actual owner",
    async (owner) => {
      const controllers = [createTerminalController(), createTerminalController()] as const;
      createGhosttyTerminalMock
        .mockResolvedValueOnce(controllers[0])
        .mockResolvedValueOnce(controllers[1]);
      const requests: Array<{ method: string; params: unknown }> = [];
      const client: TerminalGatewayClient = {
        forceReconnect: () => {},
        request: async <T>(method: string, params?: unknown) => {
          requests.push({ method, params });
          if (method === "terminal.open") {
            return terminalOpenResult("current-1") as T;
          }
          if (method === "terminal.list") {
            return {
              sessions: [
                { ...terminalOpenResult("current-1"), attached: true, createdAtMs: 1 },
                {
                  sessionId: "detached-1",
                  agentId: "detached-agent",
                  shell: "/bin/bash",
                  cwd: "/work/detached",
                  confined: false,
                  attached: false,
                  owner,
                  createdAtMs: 2,
                },
                {
                  sessionId: "remote-1",
                  agentId: "remote-agent",
                  shell: "/bin/zsh",
                  cwd: "/work/remote",
                  confined: false,
                  attached: true,
                  createdAtMs: 3,
                },
              ],
            } as T;
          }
          if (method === "terminal.attach") {
            return {
              sessionId: "detached-1",
              agentId: "detached-agent",
              shell: "/bin/bash",
              cwd: "/work/detached",
              confined: false,
              title: "codex",
              owner,
              buffer: "detached history",
              seq: "detached history".length,
            } as T;
          }
          return { ok: true } as T;
        },
        addEventListener: () => () => {},
      };
      const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
      panel.client = client;
      panel.available = true;
      document.body.append(panel);
      panel.toggle();
      await panel.updateComplete;
      await vi.dynamicImportSettled();
      await waitForFast(() => {
        expect(requests.some((request) => request.method === "terminal.open")).toBe(true);
      });

      (panel.querySelector('[aria-label="Terminal sessions"]') as HTMLButtonElement).click();
      await waitForFast(() => {
        expect(panel.querySelector(".tp-session-menu")?.textContent).toContain("detached-agent");
      });
      const menuText = panel.querySelector(".tp-session-menu")?.textContent;
      expect(menuText).toContain("/work/detached");
      expect(
        [...panel.querySelectorAll<HTMLElement>(".tp-session")]
          .find((row) => row.textContent?.includes("detached-agent"))
          ?.querySelector(".tp-session__state")?.textContent,
      ).toContain("agent");
      expect(menuText).toContain("attached");
      expect(menuText).toContain("current");
      const detachedRow = [...panel.querySelectorAll<HTMLButtonElement>(".tp-session")].find(
        (button) => button.textContent?.includes("detached-agent"),
      );
      detachedRow?.click();
      await panel.updateComplete;
      await vi.dynamicImportSettled();

      await waitForFast(() => {
        expect(requests).toContainEqual({
          method: "terminal.attach",
          params: { sessionId: "detached-1" },
        });
        expect(controllers[1].terminal.focus).toHaveBeenCalled();
      });
      expect(new TextDecoder().decode(controllers[1].write.mock.calls[0]?.[0])).toBe(
        "detached history",
      );
      expect(panel.querySelector(".tabstrip-tab__badge")?.textContent).toBe("agent");
      expect(panel.textContent).toContain("codex");
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
        JSON.stringify(["current-1", "detached-1"]),
      );
    },
  );

  it("reattaches a same-client reconnect and replaces gapped terminal state", async () => {
    const controllers = [
      createTerminalController(),
      createTerminalController(),
      createTerminalController(),
    ] as const;
    const controllerParents: HTMLElement[] = [];
    createGhosttyTerminalMock.mockImplementation(async (options) => {
      const currentIndex = createGhosttyTerminalMock.mock.calls.length - 1;
      const controller = controllers[currentIndex];
      if (!controller) {
        throw new Error("unexpected terminal controller creation");
      }
      controllerParents[currentIndex] = options.parent;
      return controller;
    });

    const requests: Array<{ method: string; params: unknown }> = [];
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const replay = "reconnected shell\r\n$ ";
    const recoveredReplay = `${replay}?gap`;
    const attachReplays = [replay, recoveredReplay] as const;
    let attachCount = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.open") {
          return terminalOpenResult("surviving-session") as T;
        }
        if (method === "terminal.list") {
          return {
            sessions: [
              { ...terminalOpenResult("surviving-session"), attached: false, createdAtMs: 1 },
            ],
          } as T;
        }
        if (method === "terminal.attach") {
          const buffer = attachReplays[attachCount++];
          if (!buffer) {
            throw new Error("unexpected terminal attach");
          }
          return {
            ...terminalOpenResult("surviving-session"),
            buffer,
            seq: buffer.length,
          } as T;
        }
        return { ok: true } as T;
      },
      addEventListener: (nextListener) => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) {
            listener = undefined;
          }
        };
      },
    };
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();

    await waitForFast(() => {
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toContain(
        "surviving-session",
      );
    });

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    await waitForFast(() => expect(controllers[0].dispose).toHaveBeenCalledOnce());

    let releaseRefresh: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(0);
    releaseRefresh?.(false);
    await waitForFast(() => {
      expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(1);
    });

    expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2);
    expect(controllers[0].dispose).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(controllers[1].write.mock.calls[0]?.[0])).toBe(replay);

    const previousHost = controllerParents[1];
    if (!previousHost) {
      throw new Error("missing reconnected terminal host");
    }
    previousHost.style.display = "none";
    previousHost.style.visibility = "collapse";

    listener?.({
      event: "terminal.data",
      payload: { sessionId: "surviving-session", seq: replay.length + 4, data: "gap" },
    });
    await waitForFast(() => expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(3));
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(2);

    await waitForFast(() => expect(controllers[1].dispose).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(controllers[2].write.mock.calls[0]?.[0])).toBe(recoveredReplay);
    expect(controllers[2].setReadOnly).toHaveBeenCalledWith(false);
    expect(controllerParents[2]?.style.display).toBe("none");
    expect(controllerParents[2]?.style.visibility).toBe("collapse");
    expect(controllerParents[2]?.inert).toBe(false);

    listener?.({
      event: "terminal.data",
      payload: { sessionId: "surviving-session", seq: recoveredReplay.length + 1, data: "!" },
    });
    await waitForFast(() => expect(controllers[2].write).toHaveBeenCalledTimes(2));
    expect(new TextDecoder().decode(controllers[2].write.mock.calls[1]?.[0])).toBe("!");
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(2);
    expect(controllers[1].dispose).toHaveBeenCalledOnce();
  });

  it("replays and deduplicates explicit terminal actions after a same-client reconnect fence", async () => {
    createGhosttyTerminalMock
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    let opened = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.attach") {
          const sessionId = (params as { sessionId: string }).sessionId;
          const buffer = `${sessionId} ready`;
          return {
            ...terminalOpenResult(sessionId),
            buffer,
            seq: buffer.length,
          } as T;
        }
        if (method === "terminal.open") {
          opened += 1;
          return terminalOpenResult(`opened-terminal-${opened}`) as T;
        }
        return { ok: true } as T;
      },
      addEventListener: () => () => {},
    };
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.agentId = "research";
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    await panel.updateComplete;

    panel.available = false;
    await panel.updateComplete;

    let releaseRefresh: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());

    const requested = new CustomEvent("openclaw:terminal-toggle", {
      detail: { open: true, terminalSessionId: "requested-terminal" },
    });
    panel.handleToggleRequest(requested);
    panel.handleToggleRequest(requested);
    const another = new CustomEvent("openclaw:terminal-toggle", {
      detail: { open: true, terminalSessionId: "another-terminal" },
    });
    panel.handleToggleRequest(another);
    panel.handleToggleRequest(another);
    await panel.updateComplete;
    const newSession = panel.querySelector<HTMLButtonElement>(
      '[aria-label="New terminal session"]',
    );
    expect(newSession?.disabled).toBe(false);
    newSession?.click();
    newSession?.click();
    panel.agentId = "main";

    expect(requests).toHaveLength(0);
    await waitForFast(() => {
      expect(
        panel
          .querySelector('openclaw-panel-loading-skeleton[data-panel-skeleton="terminal"]')
          ?.getAttribute("aria-label"),
      ).toContain("Connecting to session");
    });

    releaseRefresh?.(false);
    await waitForFast(() => {
      expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(2);
      expect(requests.filter((request) => request.method === "terminal.open")).toHaveLength(1);
    });
    expect(
      requests.filter(
        (request) => request.method === "terminal.attach" || request.method === "terminal.open",
      ),
    ).toEqual([
      { method: "terminal.attach", params: { sessionId: "requested-terminal" } },
      { method: "terminal.attach", params: { sessionId: "another-terminal" } },
      {
        method: "terminal.open",
        params: { agentId: "research", cols: 100, rows: 30 },
      },
    ]);
    expect(panel.querySelectorAll(".tabstrip-tab__badge")).toHaveLength(2);
  });

  it("cancels captured restore and explicit actions when the panel closes during the fence", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return (
          method === "terminal.open" ? terminalOpenResult("initial-terminal") : { ok: true }
        ) as T;
      },
      addEventListener: () => () => {},
    };
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await waitForFast(() => {
      expect(requests.some((request) => request.method === "terminal.open")).toBe(true);
    });

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    requests.splice(0);

    let releaseRefresh: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "cancelled-terminal" },
      }),
    );
    panel.closeTerminalPanel();
    releaseRefresh?.(false);
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    expect(panel.terminalPanelOpen).toBe(false);
    expect(requests).toHaveLength(0);
    expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull();
  });

  it("retires an older refresh generation without losing its queued action", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.attach") {
          return {
            ...terminalOpenResult("generation-terminal"),
            buffer: "ready",
            seq: 5,
          } as T;
        }
        return { ok: true } as T;
      },
      addEventListener: () => () => {},
    };
    const releases: Array<(replacementActivated: boolean) => void> = [];
    vi.mocked(refreshControlUiServiceWorker).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releases.push(resolve);
        }),
    );
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    await panel.updateComplete;

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "generation-terminal" },
      }),
    );

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    releases[0]?.(false);
    await Promise.resolve();
    expect(requests).toHaveLength(0);
    releases[1]?.(false);
    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "generation-terminal" },
      });
    });
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(1);
  });

  it("shows reload guidance when a fenced action cannot make progress", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) =>
        (method === "terminal.attach"
          ? { ...terminalOpenResult("stalled-terminal"), buffer: "ready", seq: 5 }
          : { ok: true }) as T,
      addEventListener: () => () => {},
    };
    let releaseRefresh: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    await panel.updateComplete;

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "stalled-terminal" },
      }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await panel.updateComplete;
    expect(panel.querySelector(".tp-error")?.textContent).toContain(
      "Reload this page to continue the terminal action",
    );
    expect(
      panel.querySelector('openclaw-panel-loading-skeleton[data-panel-skeleton="terminal"]'),
    ).toBeNull();

    vi.useRealTimers();
    releaseRefresh?.(false);
    await waitForFast(() => {
      expect(panel.querySelector(".is-live")).not.toBeNull();
      expect(panel.querySelector(".tp-error")).toBeNull();
    });
  });

  it("carries an explicit terminal action through an activated-worker reload", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.attach") {
          return {
            ...terminalOpenResult("requested-after-reload"),
            buffer: "reloaded terminal ready",
            seq: 23,
          } as T;
        }
        return { ok: true } as T;
      },
      addEventListener: () => () => {},
    };
    const stalePanel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    stalePanel.client = client;
    stalePanel.available = true;
    document.body.append(stalePanel);
    await stalePanel.updateComplete;

    stalePanel.client = null;
    stalePanel.available = false;
    await stalePanel.updateComplete;

    let activateReplacement: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        activateReplacement = resolve;
      }),
    );
    stalePanel.client = client;
    stalePanel.available = true;
    await stalePanel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    stalePanel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "requested-after-reload" },
      }),
    );
    activateReplacement?.(true);
    await Promise.resolve();
    expect(requests).toHaveLength(0);

    stalePanel.remove();
    const currentPanel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    currentPanel.client = client;
    currentPanel.available = true;
    document.body.append(currentPanel);

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "requested-after-reload" },
      });
    });
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(1);
  });
});
