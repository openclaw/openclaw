/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
  selectSizing,
  sizingMenu,
  mountPanel,
  updatePanel,
} from "./desktop-panel.test-support.ts";

type Connect = DesktopClient["connect"];
type Panel = ReturnType<typeof createPanel>;
const vncPassword = { auth: "vnc-password", vncPassword: "synthetic" };
const capabilities = [
  [true, true],
  [true, false],
  [false, true],
  [undefined, true],
] as const;
const sizingCases = [false, true].flatMap((documentMode) =>
  capabilities.map(([canResize, control]) => ({ documentMode, canResize, control })),
);

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function observeRequest(
  observed: object | ((params?: { control?: boolean }) => object),
  environments = [desktopEnvironment],
) {
  return vi.fn(async (method: string, params?: { control?: boolean; environmentId?: string }) => {
    if (method === "environments.list") {
      return { environments };
    }
    if (method === "environments.status") {
      const environment = environments.find((entry) => entry.id === params?.environmentId);
      if (!environment) {
        throw new Error("Unexpected desktop environment");
      }
      return environment;
    }
    if (method === "desktop.observe") {
      return {
        transport: "rfb",
        wsPath: "/view",
        ...(typeof observed === "function" ? observed(params) : observed),
      };
    }
    throw new Error(`Unexpected desktop RPC: ${method}`);
  });
}

function connections(authenticate = false) {
  const handles: ReturnType<typeof createConnectionHandle>[] = [];
  const connect = vi.fn(async (options: Parameters<Connect>[0]) => {
    const handle = createConnectionHandle();
    handles.push(handle);
    if (authenticate) {
      options.onConnect?.();
    }
    return handle;
  });
  return { handles, connect };
}

async function mount(request: unknown, connect: Connect, options: Partial<Panel> = {}) {
  const panel = createPanel();
  updatePanel(panel, {
    client: createGatewayClient(request).client,
    available: true,
    embedded: true,
    presented: true,
    requestedSource: desktopEnvironment.id,
    desktopClientFactory: () => ({ connect }),
    ...options,
  });
  await mountPanel(panel);
  await connected(panel, connect, 1);
  return panel;
}

async function connected(panel: Panel, connect: Connect, count: number) {
  await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(count));
  await panel.updateComplete;
}

it.each([
  ["worker password", { vncPassword: "synthetic" }, { password: "synthetic" }],
  ["explicit VNC", vncPassword, { password: "synthetic" }],
  ["preauthenticated VNC", { ...vncPassword, preauthenticated: true }, undefined],
  ["preauthenticated ARD", { auth: "ard-account", preauthenticated: true }, undefined],
] as const)("resolves %s credentials", async (_name, observed, credentials) => {
  const request = observeRequest({ control: false, ...observed });
  const { connect } = connections();
  await mount(request, connect);
  expect(connect.mock.calls[0]![0].credentials).toEqual(credentials);
});

it.each(sizingCases)("Match authentication: %j", async ({ documentMode, canResize, control }) => {
  const request = observeRequest({ control, canResize });
  const { connect, handles } = connections();
  const panel = await mount(request, connect, { documentMode, documentControl: control });

  const handle = handles[0]!;
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
    expect(panel.querySelectorAll(".desktop-touch-action, .desktop-sizing")).toHaveLength(6);
    const audio = panel.querySelector<HTMLButtonElement>(".desktop-audio-button");
    expect(audio?.getAttribute("aria-label")).toBe("Audio unavailable");
    expect(audio?.disabled).toBe(true);
  }
});

it.each(["retry", "demotion", "permission loss", "source change"] as const)(
  "revalidates Match after %s",
  async (transition) => {
    const replacement = { ...desktopEnvironment, id: "worker-desktop-2" };
    let canResize = true;
    const request = observeRequest(
      (params) => ({ control: params?.control, canResize }),
      [desktopEnvironment, replacement],
    );
    const { handles, connect } = connections(true);
    const panel = await mount(request, connect, { documentMode: true, documentControl: true });
    selectSizing(panel, "match");
    await panel.updateComplete;

    const original = connect.mock.calls[0]![0];
    if (transition === "source change") {
      updatePanel(panel, { requestedSource: replacement.id });
    } else if (transition === "demotion") {
      original.onDisconnect?.({ clean: true, code: 4000, reason: "control-taken" });
    } else {
      canResize = transition !== "permission loss";
      original.onDisconnect?.({ clean: false, code: 1006 });
      await panel.updateComplete;
      clickPanelButton(panel, ".desktop-status button");
    }
    await connected(panel, connect, 2);
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
  const request = observeRequest({ control: true, canResize: true });
  const { handles, connect } = connections();
  const panel = await mount(request, connect, { documentMode: true, documentControl: true });
  const initial = connect.mock.calls[0]![0];
  initial.onConnect?.();
  await panel.updateComplete;
  selectSizing(panel, "match");
  initial.onDisconnect?.({ clean: false, code: 1006 });
  await panel.updateComplete;
  clickPanelButton(panel, ".desktop-status button");
  await connected(panel, connect, 2);
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
