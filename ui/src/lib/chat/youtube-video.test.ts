import { describe, expect, it } from "vitest";
import { parseYouTubeVideoUrl } from "./youtube-video.ts";

describe("parseYouTubeVideoUrl", () => {
  it.each([
    "https://youtube.com/watch?v=AbC123_-xyz",
    "https://www.youtube.com/watch?v=AbC123_-xyz&si=tracking&autoplay=1",
    "https://m.youtube.com/watch?v=AbC123_-xyz",
    "https://youtu.be/AbC123_-xyz?si=tracking",
    "https://www.youtube.com/shorts/AbC123_-xyz",
    "https://www.youtube.com/live/AbC123_-xyz/",
    "https://www.youtube.com/embed/AbC123_-xyz?origin=https://untrusted.example",
    "https://youtube-nocookie.com/embed/AbC123_-xyz",
    "https://www.youtube-nocookie.com/embed/AbC123_-xyz",
  ])("normalizes a supported video link without copying player parameters: %s", (url) => {
    expect(parseYouTubeVideoUrl(url)).toEqual({
      videoId: "AbC123_-xyz",
      startSeconds: 0,
      watchUrl: "https://www.youtube.com/watch?v=AbC123_-xyz",
      embedUrl: "https://www.youtube-nocookie.com/embed/AbC123_-xyz?playsinline=1",
      thumbnailUrl: "https://i.ytimg.com/vi/AbC123_-xyz/hqdefault.jpg",
    });
  });

  it.each([
    ["?t=90", 90],
    ["?t=90s", 90],
    ["?t=1h2m3s", 3723],
    ["?t=2m", 120],
    ["#t=1m30s", 90],
    ["?start=15&t=30#t=45", 15],
    ["?t=30#t=45", 30],
    ["?start=0&t=30", 0],
  ] as const)("preserves the requested playback position from %s", (suffix, seconds) => {
    const video = parseYouTubeVideoUrl(`https://youtu.be/AbC123_-xyz${suffix}`);
    expect(video?.startSeconds).toBe(seconds);
    expect(video?.watchUrl).toBe(
      `https://www.youtube.com/watch?v=AbC123_-xyz${seconds > 0 ? `&t=${seconds}` : ""}`,
    );
    expect(video?.embedUrl).toBe(
      `https://www.youtube-nocookie.com/embed/AbC123_-xyz?playsinline=1${seconds > 0 ? `&start=${seconds}` : ""}`,
    );
  });

  it.each([
    undefined,
    "",
    "not a URL",
    "http://www.youtube.com/watch?v=AbC123_-xyz",
    "https://www.youtube.com.evil.example/watch?v=AbC123_-xyz",
    "https://youtube.com@evil.example/watch?v=AbC123_-xyz",
    "https://user:password@www.youtube.com/watch?v=AbC123_-xyz",
    "https://www.youtube.com:8443/watch?v=AbC123_-xyz",
    "https://www.youtube.com./watch?v=AbC123_-xyz",
    "https://www.youtube.com/playlist?list=AbC123_-xyz",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=AbC123%2F-xyz",
    "https://www.youtube.com/watch?v=AbC123_-xyz&v=other123456",
    "https://youtu.be/AbC123_-xyz/extra",
    "https://youtu.be/AbC123_-xyz?v=other123456",
    "https://www.youtube-nocookie.com/watch?v=AbC123_-xyz",
    "https://youtu.be/AbC123_-xyz?start=1&start=2",
    "https://youtu.be/AbC123_-xyz?t=1&t=2",
    "https://youtu.be/AbC123_-xyz#t=1&t=2",
    "https://youtu.be/AbC123_-xyz?t=-1",
    "https://youtu.be/AbC123_-xyz?t=1.5",
    "https://youtu.be/AbC123_-xyz?t=",
    "https://youtu.be/AbC123_-xyz?t=forever",
    "https://youtu.be/AbC123_-xyz?t=9007199254740992",
    "https://youtu.be/AbC123_-xyz?t=9007199254740991h",
  ])("rejects unsupported, misleading, or ambiguous video links: %s", (url) => {
    expect(parseYouTubeVideoUrl(url)).toBeUndefined();
  });
});
