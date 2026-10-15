/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createComposerContainer,
  createComposerProps as props,
  findComposerButton as button,
  renderComposerFixture as renderComposer,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

function iconShapes(name: IconName): string[] {
  const container = document.createElement("div");
  const view = mountSolid(() => createComponent(Icon, { name }), { container });
  try {
    return Array.from(container.querySelector("svg")?.children ?? [], (shape) => shape.outerHTML);
  } finally {
    view.unmount();
  }
}

afterEach(async () => {
  await resetComposerFixture();
});

describe("renderChatComposer video", () => {
  it("offers camera only inside a video-capable active talk session", () => {
    const onToggleRealtimeCamera = vi.fn();
    const { container } = renderComposer({
      onToggleRealtimeTalk: vi.fn(),
      onToggleRealtimeCamera,
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkVideoCapable: true,
    });

    button(container, t("chat.composer.turnCameraOn")).click();
    expect(onToggleRealtimeCamera).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Start video talk"]')).toBeNull();

    const failed = renderComposer({
      onToggleRealtimeTalk: vi.fn(),
      onToggleRealtimeCamera,
      realtimeTalkActive: true,
      realtimeTalkStatus: "error",
      realtimeTalkVideoCapable: true,
    });
    expect(button(failed.container, t("chat.composer.turnCameraOn")).disabled).toBe(true);
  });

  it("renders the camera-off glyph while the talk camera is enabled", () => {
    const { container } = renderComposer({
      onToggleRealtimeTalk: vi.fn(),
      onToggleRealtimeCamera: vi.fn(),
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkVideoCapable: true,
      realtimeTalkVideoStream: {} as MediaStream,
    });

    const cameraToggle = button(container, t("chat.composer.turnCameraOff"));
    const shapes = Array.from(
      cameraToggle.querySelector("svg")?.children ?? [],
      (shape) => shape.outerHTML,
    );
    expect(shapes).toEqual(iconShapes("cameraOff"));
    expect(shapes).not.toEqual(iconShapes("camera"));
  });

  it("offers camera switching only for a live preview with multiple cameras", () => {
    const onSwitchRealtimeCamera = vi.fn();
    const stream = {
      getVideoTracks: () => [
        {
          getSettings: () => ({ facingMode: "user" }),
        } as MediaStreamTrack,
      ],
    } as unknown as MediaStream;
    const { container } = renderComposer({
      realtimeTalkVideoStream: stream,
      realtimeTalkCameraDevices: [
        { deviceId: "front", label: "Front Camera" },
        { deviceId: "back", label: "Back Camera" },
      ],
      onSwitchRealtimeCamera,
    });

    button(container, t("chat.composer.switchCamera")).click();
    expect(onSwitchRealtimeCamera).toHaveBeenCalledOnce();
    expect(container.querySelector("video")?.classList).toContain(
      "agent-chat__video-preview-mirrored",
    );

    const singleCamera = renderComposer({
      realtimeTalkVideoStream: stream,
      realtimeTalkCameraDevices: [{ deviceId: "front", label: "Front Camera" }],
      onSwitchRealtimeCamera,
    });
    expect(
      singleCamera.container.querySelector(
        `button[aria-label="${t("chat.composer.switchCamera")}"]`,
      ),
    ).toBeNull();
  });

  it("does not mirror an environment-facing camera preview", () => {
    const stream = {
      getVideoTracks: () => [
        {
          getSettings: () => ({ facingMode: "environment" }),
        } as MediaStreamTrack,
      ],
    } as unknown as MediaStream;
    const { container } = renderComposer({ realtimeTalkVideoStream: stream });

    expect(container.querySelector("video")?.classList).not.toContain(
      "agent-chat__video-preview-mirrored",
    );
  });

  it("keeps the same camera stream attached across unrelated rerenders", () => {
    const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
    const replacementStream = { getVideoTracks: () => [] } as unknown as MediaStream;
    const container = createComposerContainer();
    const composerProps = props({
      realtimeTalkStatus: "listening",
      realtimeTalkVideoStream: stream,
    });
    const draw = () => renderComposerInto(container, composerProps);
    draw();

    const preview = container.querySelector<HTMLVideoElement>(
      `video[aria-label="${t("chat.composer.cameraPreview")}"]`,
    );
    if (!preview) {
      throw new Error("expected camera preview");
    }
    let attachedStream = preview.srcObject;
    const setSrcObject = vi.fn((next: HTMLVideoElement["srcObject"]) => {
      attachedStream = next;
    });
    Object.defineProperty(preview, "srcObject", {
      configurable: true,
      get: () => attachedStream,
      set: setSrcObject,
    });

    composerProps.realtimeTalkStatus = "thinking";
    draw();

    expect(container.querySelector("video")).toBe(preview);
    expect(setSrcObject).not.toHaveBeenCalled();

    composerProps.realtimeTalkVideoStream = replacementStream;
    draw();

    expect(setSrcObject).toHaveBeenCalledOnce();
    expect(setSrcObject).toHaveBeenCalledWith(replacementStream);
  });
});
