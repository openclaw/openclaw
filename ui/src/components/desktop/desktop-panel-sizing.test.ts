/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
  selectSizing,
  settleTasks,
  sizingMenu,
} from "./desktop-panel.test-support.ts";

describe("desktop panel sizing", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "worker password without auth metadata",
      observed: { vncPassword: "synthetic" },
      credentials: { password: "synthetic" },
    },
    {
      name: "explicit VNC password",
      observed: { auth: "vnc-password", vncPassword: "synthetic" },
      credentials: { password: "synthetic" },
    },
    {
      name: "preauthenticated VNC",
      observed: { auth: "vnc-password", vncPassword: "synthetic", preauthenticated: true },
      credentials: undefined,
    },
    {
      name: "preauthenticated ARD",
      observed: { auth: "ard-account", preauthenticated: true },
      credentials: undefined,
    },
  ])("passes only resolved credentials to noVNC for $name", async ({ observed, credentials }) => {
    const request = vi.fn(async (method: string) =>
      method === "environments.list"
        ? { environments: [desktopEnvironment] }
        : { transport: "rfb", wsPath: "/view", control: false, ...observed },
    );
    const connect = vi.fn(async (_options: Parameters<DesktopClient["connect"]>[0]) =>
      createConnectionHandle(),
    );
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(connect.mock.calls[0]![0].credentials).toEqual(credentials);
  });

  it.each(
    [false, true].flatMap((documentMode) =>
      [
        { canResize: true, control: true },
        { canResize: true, control: false },
        { canResize: false, control: true },
        { canResize: undefined, control: true },
      ].map(({ canResize, control }) => ({ documentMode, canResize, control })),
    ),
  )(
    "offers Match only after capable controller authentication ($documentMode/$canResize/$control)",
    async ({ documentMode, canResize, control }) => {
      const request = vi.fn(async (method: string) =>
        method === "environments.list"
          ? { environments: [desktopEnvironment] }
          : { transport: "rfb", wsPath: "/view", control, canResize },
      );
      const handle = createConnectionHandle();
      const connect = vi.fn(async (_options: Parameters<DesktopClient["connect"]>[0]) => handle);
      const panel = createPanel();
      panel.client = createGatewayClient(request).client;
      panel.available = true;
      panel.embedded = true;
      panel.presented = true;
      panel.documentMode = documentMode;
      panel.documentControl = control;
      panel.requestedSource = desktopEnvironment.id;
      panel.desktopClientFactory = () => ({ connect });
      document.body.append(panel);

      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      await settleTasks();
      const options = connect.mock.calls[0]![0];
      expect(options).toMatchObject({ canResize, viewOnly: !control, sizingMode: "fit" });
      expect(sizingMenu(panel).value).toBe("fit");
      expect(sizingMenu(panel).querySelector('option[value="match"]')).toBeNull();
      options.onConnect?.();
      await panel.updateComplete;
      expect(Boolean(sizingMenu(panel).querySelector('option[value="match"]'))).toBe(
        canResize === true && control,
      );
      selectSizing(panel, "actual");
      expect(handle.setSizingMode).toHaveBeenLastCalledWith("actual");
      selectSizing(panel, "fit");
      expect(handle.setSizingMode).toHaveBeenLastCalledWith("fit");
      if (canResize && control) {
        selectSizing(panel, "match");
        await panel.updateComplete;
        expect(sizingMenu(panel).value).toBe("match");
        expect(handle.setSizingMode).toHaveBeenLastCalledWith("match");
      }
      if (documentMode) {
        expect(
          panel.renderRoot.querySelectorAll(".desktop-touch-action, .desktop-sizing"),
        ).toHaveLength(4);
      }
    },
  );

  it.each(["retry", "demotion", "permission loss", "source change"] as const)(
    "revalidates Match after %s",
    async (transition) => {
      const replacement = { ...desktopEnvironment, id: "worker-desktop-2" };
      let canResize = true;
      const request = vi.fn(async (method: string, params?: { control?: boolean }) =>
        method === "environments.list"
          ? { environments: [desktopEnvironment, replacement] }
          : { transport: "rfb", wsPath: "/view", control: params?.control, canResize },
      );
      const handles: ReturnType<typeof createConnectionHandle>[] = [];
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        const handle = createConnectionHandle();
        handles.push(handle);
        options.onConnect?.();
        return handle;
      });
      const panel = createPanel();
      panel.client = createGatewayClient(request).client;
      panel.available = true;
      panel.embedded = true;
      panel.presented = true;
      panel.documentMode = true;
      panel.documentControl = true;
      panel.requestedSource = desktopEnvironment.id;
      panel.desktopClientFactory = () => ({ connect });
      document.body.append(panel);
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      await settleTasks();
      selectSizing(panel, "match");
      await panel.updateComplete;

      const original = connect.mock.calls[0]![0];
      if (transition === "source change") {
        panel.requestedSource = replacement.id;
      } else if (transition === "demotion") {
        original.onDisconnect?.({ clean: true, code: 4000, reason: "control-taken" });
      } else {
        canResize = transition !== "permission loss";
        original.onDisconnect?.({ clean: false, code: 1006 });
        await panel.updateComplete;
        clickPanelButton(panel, ".desktop-status button");
      }
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
      await settleTasks();
      expect(handles[0]!.disconnect).toHaveBeenCalledOnce();
      expect(original.isCurrent()).toBe(false);
      expect(connect.mock.calls[1]![0].sizingMode).toBe(transition === "retry" ? "match" : "fit");
      expect(sizingMenu(panel).value).toBe(transition === "retry" ? "match" : "fit");
      expect(Boolean(sizingMenu(panel).querySelector('option[value="match"]'))).toBe(
        transition === "retry" || transition === "source change",
      );
      original.onConnect?.();
      await panel.updateComplete;
      expect(sizingMenu(panel).value).toBe(transition === "retry" ? "match" : "fit");
    },
  );

  it("applies Fit selected during a Match reconnect before authentication enables sizing", async () => {
    const request = vi.fn(async (method: string) =>
      method === "environments.list"
        ? { environments: [desktopEnvironment] }
        : { transport: "rfb", wsPath: "/view", control: true, canResize: true },
    );
    const handles = [createConnectionHandle(), createConnectionHandle()];
    let connectionIndex = 0;
    const connect = vi.fn(
      async (_options: Parameters<DesktopClient["connect"]>[0]) => handles[connectionIndex++]!,
    );
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.documentMode = true;
    panel.documentControl = true;
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    await settleTasks();
    const initial = connect.mock.calls[0]![0];
    initial.onConnect?.();
    await panel.updateComplete;
    selectSizing(panel, "match");
    initial.onDisconnect?.({ clean: false, code: 1006 });
    await panel.updateComplete;
    clickPanelButton(panel, ".desktop-status button");
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    await settleTasks();
    const pending = connect.mock.calls[1]![0];
    expect(pending.sizingMode).toBe("match");
    expect(sizingMenu(panel).value).toBe("match");
    expect(sizingMenu(panel).selectedOptions[0]?.disabled).toBe(true);
    selectSizing(panel, "fit");
    expect(handles[1]!.setSizingMode).toHaveBeenLastCalledWith("fit");
    expect(handles[0]!.setSizingMode).toHaveBeenLastCalledWith("match");
    pending.onConnect?.();
    await panel.updateComplete;
    expect(sizingMenu(panel).value).toBe("fit");
    expect(handles[1]!.setSizingMode).toHaveBeenLastCalledWith("fit");
  });
});
