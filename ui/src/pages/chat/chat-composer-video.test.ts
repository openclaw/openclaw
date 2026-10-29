/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Icon } from "../../components/solid/icon.tsx";
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
const previewClass = "agent-chat__video-preview-mirrored";
const switchLabel = () => t("chat.composer.switchCamera");
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
  const { container, props } = talk({ onToggleRealtimeCamera });
  button(container, t("chat.composer.turnCameraOn")).click();
  expect(onToggleRealtimeCamera).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="Start video talk"]')).toBeNull();
  props.realtimeTalkVideoStream = {} as MediaStream;
  renderComposerInto(container, props);
  expect(button(container, t("chat.composer.turnCameraOff")).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(shapes(button(container, t("chat.composer.turnCameraOff")))).toEqual(
    shapes(mountSolid(() => createComponent(Icon, { name: "cameraOff" })).container),
  );
  const failed = talk({ onToggleRealtimeCamera, realtimeTalkStatus: "error" });
  expect(button(failed.container, t("chat.composer.turnCameraOn")).disabled).toBe(true);
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
  const switchButton = button(container, switchLabel());
  switchButton.click();
  expect(onSwitchRealtimeCamera).toHaveBeenCalledOnce();
  const replacementSwitch = vi.fn();
  props.onSwitchRealtimeCamera = replacementSwitch;
  renderComposerInto(container, props);
  expect(button(container, switchLabel())).toBe(switchButton);
  switchButton.click();
  expect(replacementSwitch).toHaveBeenCalledOnce();
  expect(onSwitchRealtimeCamera).toHaveBeenCalledOnce();
  expect(container.querySelector("video")?.classList).toContain(previewClass);
  const single = renderComposer({ ...props, realtimeTalkCameraDevices: [front] });
  expect(single.container.querySelector(`button[aria-label="${switchLabel()}"]`)).toBeNull();
});

it("does not mirror an environment-facing preview", () => {
  const { container } = renderComposer({ realtimeTalkVideoStream: cameraStream("environment") });
  expect(container.querySelector("video")?.classList).not.toContain(previewClass);
});

it("reattaches only a changed camera stream, not on unrelated rerenders", () => {
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
  const replacement = { getVideoTracks: () => [] } as unknown as MediaStream;
  const { container, props } = renderComposer({
    realtimeTalkStatus: "listening",
    realtimeTalkVideoStream: stream,
  });
  const preview = container.querySelector<HTMLVideoElement>("video")!;
  expect(preview.getAttribute("aria-label")).toBe(t("chat.composer.cameraPreview"));
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
