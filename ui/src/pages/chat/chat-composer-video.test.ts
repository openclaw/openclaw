/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  findComposerButton as button,
  renderComposerFixture as renderComposer,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

const shapes = (root: ParentNode) =>
  Array.from(root.querySelector("svg")?.children ?? [], (shape) => shape.outerHTML);
function iconShapes(name: IconName) {
  return shapes(mountSolid(() => createComponent(Icon, { name })).container);
}
function talk(overrides: Parameters<typeof renderComposer>[0] = {}) {
  return renderComposer({
    onToggleRealtimeTalk: vi.fn(),
    onToggleRealtimeCamera: vi.fn(),
    realtimeTalkActive: true,
    realtimeTalkStatus: "listening",
    realtimeTalkVideoCapable: true,
    ...overrides,
  });
}
function cameraStream(facingMode: string): MediaStream {
  return {
    getVideoTracks: () => [{ getSettings: () => ({ facingMode }) } as MediaStreamTrack],
  } as unknown as MediaStream;
}
afterEach(() => resetComposerFixture());

it("enables the camera only for a healthy video-capable talk session", () => {
  const onToggleRealtimeCamera = vi.fn();
  const { container } = talk({ onToggleRealtimeCamera });
  button(container, t("chat.composer.turnCameraOn")).click();
  expect(onToggleRealtimeCamera).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="Start video talk"]')).toBeNull();
  const failed = talk({ onToggleRealtimeCamera, realtimeTalkStatus: "error" });
  expect(button(failed.container, t("chat.composer.turnCameraOn")).disabled).toBe(true);
});

it("uses the camera-off glyph while the camera is enabled", () => {
  const { container } = talk({ realtimeTalkVideoStream: {} as MediaStream });
  const glyph = shapes(button(container, t("chat.composer.turnCameraOff")));
  expect(glyph).toEqual(iconShapes("cameraOff"));
  expect(glyph).not.toEqual(iconShapes("camera"));
});

it("switches multiple cameras and mirrors a user-facing preview", () => {
  const onSwitchRealtimeCamera = vi.fn();
  const stream = cameraStream("user");
  const front = { deviceId: "front", label: "Front Camera" };
  const { container, props } = renderComposer({
    realtimeTalkVideoStream: stream,
    onSwitchRealtimeCamera,
    realtimeTalkCameraDevices: [front, { deviceId: "back", label: "Back Camera" }],
  });
  button(container, t("chat.composer.switchCamera")).click();
  expect(onSwitchRealtimeCamera).toHaveBeenCalledOnce();
  expect(container.querySelector("video")?.classList).toContain(
    "agent-chat__video-preview-mirrored",
  );
  const single = renderComposer({ ...props, realtimeTalkCameraDevices: [front] });
  expect(
    single.container.querySelector(`button[aria-label="${t("chat.composer.switchCamera")}"]`),
  ).toBeNull();
});

it("does not mirror an environment-facing preview", () => {
  const { container } = renderComposer({ realtimeTalkVideoStream: cameraStream("environment") });
  expect(container.querySelector("video")?.classList).not.toContain(
    "agent-chat__video-preview-mirrored",
  );
});

it("reattaches only a changed camera stream, not on unrelated rerenders", () => {
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
  const replacement = { getVideoTracks: () => [] } as unknown as MediaStream;
  const { container, props } = renderComposer({
    realtimeTalkStatus: "listening",
    realtimeTalkVideoStream: stream,
  });
  const preview = container.querySelector<HTMLVideoElement>(
    `video[aria-label="${t("chat.composer.cameraPreview")}"]`,
  )!;
  let attachedStream = preview.srcObject;
  const setSrcObject = vi.fn((next: HTMLVideoElement["srcObject"]) => {
    attachedStream = next;
  });
  Object.defineProperty(preview, "srcObject", {
    configurable: true,
    get: () => attachedStream,
    set: setSrcObject,
  });
  props.realtimeTalkStatus = "thinking";
  renderComposerInto(container, props);
  expect(container.querySelector("video")).toBe(preview);
  expect(setSrcObject).not.toHaveBeenCalled();
  props.realtimeTalkVideoStream = replacement;
  renderComposerInto(container, props);
  expect(setSrcObject).toHaveBeenCalledExactlyOnceWith(replacement);
});
