import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import type { VideoCompressionRequest, VideoCompressionResponse } from "./chat-attachment-video.ts";

const reply = (message: VideoCompressionResponse) =>
  globalThis.postMessage(message, { transfer: [] });

async function compress(data: VideoCompressionRequest) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(data.file) });
  let conversion: Conversion | undefined;
  try {
    const videos = await input.getVideoTracks();
    const audios = await input.getAudioTracks();
    const duration = await input.computeDuration();
    if (videos.length !== 1 || !Number.isFinite(duration) || duration <= 0) {
      reply({ type: "error", reason: "unsupported" });
      return;
    }
    const width = await videos[0]!.getDisplayWidth();
    const height = await videos[0]!.getDisplayHeight();
    const scale = Math.min(1, 1920 / Math.max(width, height));
    const outputWidth = Math.max(2, Math.round((width * scale) / 2) * 2);
    const outputHeight = Math.max(2, Math.round((height * scale) / 2) * 2);
    // Keep audio rather than silently dropping it. WebM is the fallback on
    // browsers without an H.264/AAC encoder (notably Linux Chromium).
    const mp4 =
      (await canEncodeVideo("avc", { width: outputWidth, height: outputHeight })) &&
      (audios.length === 0 || (await canEncodeAudio("aac")));
    const codec = mp4 ? "avc" : "vp9";
    const audioCodec = mp4 ? "aac" : "opus";
    if (
      !mp4 &&
      (!(await canEncodeVideo(codec, { width: outputWidth, height: outputHeight })) ||
        (audios.length > 0 && !(await canEncodeAudio(audioCodec))))
    ) {
      reply({ type: "error", reason: "unsupported" });
      return;
    }
    const audioBitrate = 96_000;
    let videoBitrate = Math.floor(
      (data.maxBytes * 8 * 0.82) / duration - audios.length * audioBitrate,
    );
    // Allow a measured retry without retaining unbounded encoder output. Reuse
    // this capacity across attempts; bitrate is only an advisory codec target.
    const buffer = new Uint8Array(data.maxBytes * 2);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (videoBitrate < 100_000) {
        reply({ type: "error", reason: "too-large" });
        return;
      }
      let size = 0;
      let exceeded = false;
      // Stream targets also avoid MP4's default in-memory fast-start buffering.
      const target = new StreamTarget(
        new WritableStream({
          write({ data: chunk, position }) {
            if (exceeded) {
              return;
            }
            const end = position + chunk.byteLength;
            if (end > buffer.length) {
              exceeded = true;
              // Cancellation closes this stream, so the sink must not await it.
              void conversion?.cancel().catch(() => {});
              return;
            }
            buffer.set(chunk, position);
            size = Math.max(size, end);
          },
        }),
      );
      const output = new Output({
        target,
        format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
      });
      conversion = await Conversion.init({
        input,
        output,
        showWarnings: false,
        video: {
          codec,
          width: outputWidth,
          height: outputHeight,
          fit: "contain",
          frameRate: 30,
          quality: new Quality({ bitrate: videoBitrate }),
          forceTranscode: true,
          allowTransformationMetadata: false,
        },
        audio: {
          codec: audioCodec,
          quality: new Quality({ bitrate: audioBitrate }),
          forceTranscode: true,
        },
      });
      if (!conversion.isValid || conversion.discardedTracks.length > 0) {
        reply({ type: "error", reason: "unsupported" });
        return;
      }
      let lastProgress = -1;
      conversion.onProgress = (progress) => {
        const rounded = Math.floor(progress * 100);
        if (rounded !== lastProgress) {
          lastProgress = rounded;
          reply({
            type: "progress",
            progress: attempt === 0 ? progress * 0.9 : 0.9 + progress * 0.1,
          });
        }
      };
      try {
        await conversion.execute();
      } catch (error) {
        if (!exceeded) {
          throw error;
        }
      }
      if (exceeded) {
        reply({ type: "error", reason: "too-large" });
        return;
      }
      if (size === 0) {
        throw new Error("Empty compression result");
      }
      if (size <= data.maxBytes) {
        const extension = mp4 ? "mp4" : "webm";
        const name =
          (data.file.name.replace(/\.[^.]+$/, "") || "video") + "-compressed." + extension;
        reply({
          type: "ready",
          file: new File([buffer.subarray(0, size)], name, { type: "video/" + extension }),
        });
        return;
      }
      // Encoders treat bitrate as a target, not a cap. One measured retry is
      // allowed; bytes are checked again by the attachment admission owner.
      videoBitrate = Math.floor(((videoBitrate * data.maxBytes) / size) * 0.8);
    }
    reply({ type: "error", reason: "too-large" });
  } catch {
    reply({ type: "error", reason: "failed" });
  } finally {
    await conversion?.cancel();
    input.dispose();
  }
}

function onMessage({ data }: MessageEvent<VideoCompressionRequest>) {
  globalThis.removeEventListener("message", onMessage);
  void compress(data).catch(() => reply({ type: "error", reason: "failed" }));
}

globalThis.addEventListener("message", onMessage);
