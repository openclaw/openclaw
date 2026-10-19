/* @vitest-environment jsdom */
import type { DesktopObserveResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  AudioSocketMock,
  desktopAudioStream,
  stubDesktopAudio,
} from "./desktop-audio.test-support.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
  mountPanel,
  unmountPanel,
  updatePanel,
} from "./desktop-panel.test-support.ts";
import { AudioContextMock } from "./desktop-pcm-queue.test-support.ts";

const observation: DesktopObserveResult = {
  transport: "rfb",
  wsPath: "/desktop/observe",
  expiresAtMs: Date.now() + 60_000,
  control: false,
  audio: desktopAudioStream,
};
beforeEach(() => {
  stubDesktopAudio();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.useFakeTimers();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup(
  audio = true,
  documentMode = false,
  setupUnavailable = false,
  pending?: Promise<DesktopObserveResult>,
) {
  const request = vi.fn(async (method: string) =>
    method === "environments.status"
      ? desktopEnvironment
      : (pending ?? {
          ...observation,
          audio: audio ? desktopAudioStream : undefined,
          ...(setupUnavailable ? { audioUnavailableReason: "setup-unavailable" } : {}),
        }),
  );
  const handle = createConnectionHandle();
  const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
    options.onConnect?.();
    return handle;
  });
  const panel = createPanel();
  updatePanel(panel, {
    client: createGatewayClient(request).client,
    available: true,
    embedded: !documentMode,
    presented: true,
    documentMode,
    sessionKey: "main",
    requestedSource: desktopEnvironment.id,
    desktopClientFactory: () => ({ connect }),
  });
  await mountPanel(panel);
  await panel.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  if (!pending) {
    expect(connect).toHaveBeenCalledOnce();
  }
  AudioSocketMock.instances[0]?.open();
  await panel.updateComplete;
  return { panel, handle, connect, request };
}

it.each([false, true])("clicks to unmute (document=%s)", async (documentMode) => {
  const { panel } = await setup(true, documentMode);
  const socket = AudioSocketMock.instances[0]!;
  expect(AudioContextMock.instances).toHaveLength(0);
  expect(socket.send).not.toHaveBeenCalled();
  clickPanelButton(panel, "[aria-label='Unmute desktop audio']");
  expect(AudioContextMock.instances[0]!.resume).toHaveBeenCalledOnce();
  await panel.updateComplete;
  expect(socket.send).toHaveBeenCalledWith('{"action":"start"}');
  socket.message('{"state":"started"}');
  await panel.updateComplete;
  clickPanelButton(panel, "[aria-label='Mute desktop audio']");
  expect(socket.send).toHaveBeenLastCalledWith('{"action":"stop"}');
  expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
});

it.each([
  { documentMode: false, setupUnavailable: false },
  { documentMode: false, setupUnavailable: true },
  { documentMode: true, setupUnavailable: true },
])(
  "unavailable: setup=$setupUnavailable, document=$documentMode",
  async ({ documentMode, setupUnavailable }) => {
    const { panel, handle } = await setup(false, documentMode, setupUnavailable);
    const button = panel.querySelector<HTMLButtonElement>(".desktop-audio-button")!;
    expect(button.textContent).toContain("Audio unavailable");
    expect(AudioSocketMock.instances).toHaveLength(0);
    if (!setupUnavailable) {
      expect(button.disabled).toBe(true);
      expect(panel.textContent).not.toContain("pulseaudio");
      return;
    }
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const tooltip = () =>
      panel.querySelector<HTMLElement & { content: string }>("openclaw-tooltip");
    expect(tooltip()?.content).toContain("pulseaudio and pulseaudio-utils");
    expect(tooltip()?.content).toContain("restart the managed desktop");
    expect(tooltip()?.hasAttribute("open-on-click")).toBe(true);
    expect(panel.querySelector("[role='alert']")).toBeNull();
    button.focus();
    expect(panel.ownerDocument.activeElement).toBe(button);
    button.click();
    updatePanel(panel, { presented: false });
    await panel.updateComplete;
    updatePanel(panel, { presented: true });
    await panel.updateComplete;
    expect(tooltip()?.content).toContain("restart the managed desktop");
    expect(panel.querySelector("[role='alert']")).toBeNull();
    expect(AudioSocketMock.instances).toHaveLength(0);
    expect(AudioContextMock.instances).toHaveLength(0);
    expect(handle.disconnect).not.toHaveBeenCalled();
  },
);

it.each([false, true])("explicitly reconnects hidden audio (pending=%s)", async (pending) => {
  const observed = createDeferred<DesktopObserveResult>();
  const pendingObservation = pending ? observed.promise : undefined;
  const { panel, handle, connect, request } = await setup(true, false, false, pendingObservation);
  if (pending) {
    expect(request).toHaveBeenCalledWith("desktop.observe", expect.anything());
    expect(connect).not.toHaveBeenCalled();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    observed.resolve({ ...observation, expiresAtMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    await panel.updateComplete;
    expect(connect).toHaveBeenCalledOnce();
    expect(AudioSocketMock.instances).toHaveLength(0);
    expect(AudioContextMock.instances).toHaveLength(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
  } else {
    clickPanelButton(panel, "[aria-label='Unmute desktop audio']");
    await panel.updateComplete;
    updatePanel(panel, { presented: false });
    await panel.updateComplete;
    expect(AudioSocketMock.instances[0]!.close).toHaveBeenCalledOnce();
    expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
    expect(handle.disconnect).not.toHaveBeenCalled();
    updatePanel(panel, { presented: true });
  }
  await panel.updateComplete;
  expect(connect).toHaveBeenCalledOnce();
  const reconnect = panel.querySelector<HTMLButtonElement>(
    "[aria-label='Reconnect desktop for audio']",
  );
  expect(reconnect).not.toBeNull();
  expect(reconnect!.disabled).toBe(false);
  expect(AudioSocketMock.instances).toHaveLength(pending ? 0 : 1);
  expect(AudioContextMock.instances).toHaveLength(pending ? 0 : 1);
  expect(handle.disconnect).not.toHaveBeenCalled();
  reconnect!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(connect).toHaveBeenCalledTimes(2);
  const socket = AudioSocketMock.instances.at(-1)!;
  socket.open();
  await panel.updateComplete;
  expect(socket.send).not.toHaveBeenCalled();
  expect(AudioContextMock.instances).toHaveLength(pending ? 0 : 1);
  expect(panel.querySelector("[aria-label='Unmute desktop audio']")).not.toBeNull();
});

it.each(["source", "disconnect", "unmount", "unmount-pending", "tab-hidden"])(
  "tears down playback on %s",
  async (reason) => {
    const resume = reason === "unmount-pending" ? createDeferred() : undefined;
    if (resume) {
      const resumePromise = resume.promise;
      vi.stubGlobal(
        "AudioContext",
        class extends AudioContextMock {
          override resume = vi.fn(() => resumePromise);
        },
      );
    }
    const { panel } = await setup();
    clickPanelButton(panel, "[aria-label='Unmute desktop audio']");
    await panel.updateComplete;
    if (reason === "source") {
      updatePanel(panel, { requestedSource: "other" });
    } else if (reason === "disconnect") {
      clickPanelButton(panel, "[aria-label='Disconnect']");
    } else if (reason === "unmount" || reason === "unmount-pending") {
      await unmountPanel(panel);
    } else {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await panel.updateComplete;
    expect(AudioSocketMock.instances[0]!.close).toHaveBeenCalledOnce();
    expect(AudioSocketMock.instances[0]!.listenerCount).toBe(0);
    expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
    if (resume) {
      resume.resolve();
      await Promise.resolve();
      expect(AudioSocketMock.instances[0]!.send).not.toHaveBeenCalledWith('{"action":"start"}');
    }
  },
);

it("checks current visibility at click time before the next render", async () => {
  const { panel } = await setup();
  const button = panel.querySelector<HTMLButtonElement>(".desktop-audio-button")!;
  updatePanel(panel, { presented: false });
  button.click();
  expect(AudioContextMock.instances).toHaveLength(0);
  updatePanel(panel, { presented: true });
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  button.click();
  expect(AudioContextMock.instances).toHaveLength(0);
  await panel.updateComplete;
});

it("renders an actionable error without disconnecting the screen", async () => {
  const { panel, handle } = await setup();
  AudioSocketMock.instances[0]!.dispatchEvent(new Event("error"));
  await panel.updateComplete;
  expect(panel.querySelector("[role='alert']")?.textContent).toContain("Reconnect the desktop");
  expect(handle.disconnect).not.toHaveBeenCalled();
});
