import { raceWithTimeout } from "@openclaw/retry";
import { listen } from "../../../lib/reactive/listener.ts";

export type RealtimeTalkVideoFrame = {
  data: string;
  mimeType: "image/jpeg";
};

const REALTIME_TALK_FRAME_MAX_ATTEMPTS = 8;

export async function captureRealtimeTalkVideoFrame(
  video: HTMLVideoElement | null,
  maxMessageSize: number,
  buildMessage: (frame: RealtimeTalkVideoFrame) => unknown,
): Promise<RealtimeTalkVideoFrame> {
  if (!video?.srcObject) {
    throw new Error("Camera preview is unavailable");
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForRealtimeTalkVideoData(video);
  }
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !video.videoWidth ||
    !video.videoHeight
  ) {
    throw new Error("Camera frame has no image data");
  }
  let scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Camera frame capture is unavailable");
  }
  let quality = 0.8;
  for (let attempt = 0; attempt < REALTIME_TALK_FRAME_MAX_ATTEMPTS; attempt += 1) {
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageUrl = canvas.toDataURL("image/jpeg", quality);
    const frame: RealtimeTalkVideoFrame = {
      data: imageUrl.slice(imageUrl.indexOf(",") + 1),
      mimeType: "image/jpeg",
    };
    const messageBytes = new TextEncoder().encode(JSON.stringify(buildMessage(frame))).length;
    if (messageBytes <= maxMessageSize) {
      return frame;
    }
    const reduction = Math.min(0.75, Math.sqrt(maxMessageSize / messageBytes) * 0.9);
    scale *= reduction;
    quality = Math.max(0.4, quality - 0.1);
  }
  throw new Error("Camera frame is too large for the Realtime connection");
}

async function waitForRealtimeTalkVideoData(video: HTMLVideoElement): Promise<void> {
  const ready = Promise.withResolvers<void>();
  const removeListener = listen(video, "loadeddata", () => ready.resolve());
  // If a native readiness event is missed, the deadline reports the failure.
  try {
    await raceWithTimeout(ready.promise, 5_000, () => {
      throw new Error("Camera preview did not become ready");
    });
  } finally {
    removeListener();
  }
}
