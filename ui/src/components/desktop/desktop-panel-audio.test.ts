/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "./desktop-panel.test-support.ts";
import { AudioContextMock } from "./desktop-pcm-queue.test-support.ts";

describe("desktop panel audio wiring", () => {
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

  async function setup(audio = true, documentMode = false, setupUnavailable = false) {
    const request = vi.fn(async (method: string) =>
      method === "environments.status"
        ? desktopEnvironment
        : {
            transport: "rfb",
            wsPath: "/desktop/observe",
            control: false,
            ...(audio ? { audio: desktopAudioStream } : {}),
            ...(setupUnavailable ? { audioUnavailableReason: "setup-unavailable" } : {}),
          },
    );
    const handle = createConnectionHandle();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return handle;
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = !documentMode;
    panel.presented = true;
    panel.documentMode = documentMode;
    panel.sessionKey = "main";
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledOnce();
    AudioSocketMock.instances[0]?.open();
    await panel.updateComplete;
    return { panel, handle, connect };
  }

  it.each([false])("offers real click-to-unmute in document mode %s", async (documentMode) => {
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

  it("shows unavailable rather than a working toggle when audio is not advertised", async () => {
    const { panel } = await setup(false);
    const button = panel.renderRoot.querySelector<HTMLButtonElement>(".desktop-audio-button")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Audio unavailable");
    expect(AudioSocketMock.instances).toHaveLength(0);
    expect(panel.renderRoot.textContent).not.toContain("pulseaudio");
  });

  it.each([false])(
    "shows actionable managed setup failure without audio or RFB teardown (document %s)",
    async (documentMode) => {
      const { panel, handle } = await setup(false, documentMode, true);
      const button = panel.renderRoot.querySelector<HTMLButtonElement>(".desktop-audio-button")!;
      expect(button.disabled).toBe(true);
      const notice = () => panel.renderRoot.querySelector("[role='alert']")?.textContent;
      expect(notice()).toContain("pulseaudio and pulseaudio-utils");
      expect(notice()).toContain("restart the managed desktop");
      panel.presented = false;
      await panel.updateComplete;
      panel.presented = true;
      await panel.updateComplete;
      expect(notice()).toContain("restart the managed desktop");
      expect(AudioSocketMock.instances).toHaveLength(0);
      expect(AudioContextMock.instances).toHaveLength(0);
      expect(handle.disconnect).not.toHaveBeenCalled();
    },
  );

  it("closes hidden audio without retiring RFB and requests a fresh ticket only on explicit reconnect", async () => {
    const { panel, handle, connect } = await setup();
    clickPanelButton(panel, "[aria-label='Unmute desktop audio']");
    await panel.updateComplete;
    panel.presented = false;
    await panel.updateComplete;
    expect(AudioSocketMock.instances[0]!.close).toHaveBeenCalledOnce();
    expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
    expect(handle.disconnect).not.toHaveBeenCalled();
    panel.presented = true;
    await panel.updateComplete;
    expect(connect).toHaveBeenCalledOnce();
    expect(AudioSocketMock.instances).toHaveLength(1);
    clickPanelButton(panel, "[aria-label='Reconnect desktop for audio']");
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
    const fresh = AudioSocketMock.instances[1]!;
    fresh.open();
    await panel.updateComplete;
    expect(fresh.send).not.toHaveBeenCalled();
    expect(panel.renderRoot.querySelector("[aria-label='Unmute desktop audio']")).not.toBeNull();
  });

  it("keeps delayed advertised audio reconnectable when observation completes in a hidden tab", async () => {
    const observed = createDeferred<{
      transport: "rfb";
      wsPath: string;
      control: boolean;
      audio: typeof desktopAudioStream;
    }>();
    const request = vi.fn(async (method: string) =>
      method === "environments.status" ? desktopEnvironment : observed.promise,
    );
    const handle = createConnectionHandle();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return handle;
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.sessionKey = "main";
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith("desktop.observe", expect.anything());
    expect(connect).not.toHaveBeenCalled();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    observed.resolve({
      transport: "rfb",
      wsPath: "/desktop/observe",
      control: false,
      audio: desktopAudioStream,
    });
    await vi.advanceTimersByTimeAsync(0);
    await panel.updateComplete;
    expect(connect).toHaveBeenCalledOnce();
    expect(AudioSocketMock.instances).toHaveLength(0);
    expect(AudioContextMock.instances).toHaveLength(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await panel.updateComplete;
    const reconnect = panel.renderRoot.querySelector<HTMLButtonElement>(
      "[aria-label='Reconnect desktop for audio']",
    );
    expect(reconnect).not.toBeNull();
    expect(reconnect!.disabled).toBe(false);
    expect(AudioSocketMock.instances).toHaveLength(0);
    expect(AudioContextMock.instances).toHaveLength(0);
    expect(handle.disconnect).not.toHaveBeenCalled();
    reconnect!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
    const socket = AudioSocketMock.instances[0]!;
    socket.open();
    await panel.updateComplete;
    expect(socket.send).not.toHaveBeenCalled();
    expect(AudioContextMock.instances).toHaveLength(0);
    expect(panel.renderRoot.querySelector("[aria-label='Unmute desktop audio']")).not.toBeNull();
  });

  it.each(["source", "disconnect", "unmount", "tab-hidden"])(
    "tears down playback on %s",
    async (reason) => {
      const { panel } = await setup();
      clickPanelButton(panel, "[aria-label='Unmute desktop audio']");
      await panel.updateComplete;
      if (reason === "source") {
        panel.requestedSource = "other";
      } else if (reason === "disconnect") {
        clickPanelButton(panel, "[aria-label='Disconnect']");
      } else if (reason === "unmount") {
        panel.remove();
      } else {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      }
      await panel.updateComplete;
      expect(AudioSocketMock.instances[0]!.close).toHaveBeenCalledOnce();
      expect(AudioSocketMock.instances[0]!.listenerCount).toBe(0);
      expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
    },
  );

  it("checks current visibility at click time before the next render", async () => {
    const { panel } = await setup();
    const button = panel.renderRoot.querySelector<HTMLButtonElement>(".desktop-audio-button")!;
    panel.presented = false;
    button.click();
    expect(AudioContextMock.instances).toHaveLength(0);
    // The event closure must also observe current document visibility.
    panel.presented = true;
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    button.click();
    expect(AudioContextMock.instances).toHaveLength(0);
    await panel.updateComplete;
  });

  it("renders an actionable error without disconnecting the screen", async () => {
    const { panel, handle } = await setup();
    AudioSocketMock.instances[0]!.dispatchEvent(new Event("error"));
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector("[role='alert']")?.textContent).toContain(
      "Reconnect the desktop",
    );
    expect(handle.disconnect).not.toHaveBeenCalled();
  });
});
