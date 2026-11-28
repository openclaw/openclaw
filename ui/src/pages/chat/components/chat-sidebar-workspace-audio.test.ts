/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { ARTIFACT_DOWNLOAD_TTL_MS } from "../../../../../packages/gateway-protocol/src/artifact-download.ts";
import { GatewayRequestError } from "../../../api/gateway-connect-errors.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "./chat-detail-panel.tsx";

it("keeps the workspace player mounted across grant expiry and a failed renewal", async () => {
  vi.useFakeTimers();
  // Grant renewal uses elapsed time even when the browser wall clock is ahead.
  vi.setSystemTime(Date.now() + ARTIFACT_DOWNLOAD_TTL_MS - 1_000);
  const first = { url: "/api/artifacts/download/audio/first", filename: "sample.mp3" };
  const renewed = { ...first, url: "/api/artifacts/download/audio/renewed" };
  const download = vi
    .fn(async (_signal: AbortSignal) => renewed)
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Gateway busy",
        retryable: true,
        retryAfterMs: 8_000,
      }),
    );
  const panel = document.createElement("openclaw-chat-detail-panel");
  try {
    panel.content = {
      kind: "attachment",
      attachmentKind: "audio",
      title: first.filename,
      mimeType: "audio/mpeg",
      sourceIdentity: first.filename,
      file: { path: first.filename, download },
    };
    document.body.append(panel);
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    flush();
    const player = panel.querySelector("openclaw-chat-audio-player");
    expect(player?.src).toBe(first.url);
    await vi.advanceTimersByTimeAsync(ARTIFACT_DOWNLOAD_TTL_MS - 30_001);
    expect(download).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    flush();
    expect(download).toHaveBeenCalledTimes(2);
    expect(player?.src).toBe(first.url);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(download).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    flush();
    expect(panel.querySelector("openclaw-chat-audio-player")).toBe(player);
    expect(player?.src).toBe(renewed.url);
    download.mockRejectedValueOnce(
      new GatewayRequestError({ code: "UNAVAILABLE", message: "Session ended", retryable: false }),
    );
    await vi.advanceTimersByTimeAsync(ARTIFACT_DOWNLOAD_TTL_MS * 2);
    expect(download).toHaveBeenCalledTimes(4);
    expect(player?.src).toBe(renewed.url);
  } finally {
    panel.remove();
    vi.useRealTimers();
  }
});
