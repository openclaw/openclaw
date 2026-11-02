export type YouTubeVideo = NonNullable<ReturnType<typeof parseYouTubeVideoUrl>>;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTUBE_EMBED_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;

/** Resolves supported video links into fixed YouTube player and image origins. */
export function parseYouTubeVideoUrl(raw: string | undefined) {
  if (!raw) {
    return undefined;
  }
  const url = URL.parse(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) {
    return undefined;
  }
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    ["v", "start", "t"].some((key) => query.getAll(key).length > 1) ||
    fragment.getAll("t").length > 1
  ) {
    return undefined;
  }
  let videoId: string | null | undefined;
  if (YOUTUBE_HOSTS.has(url.hostname) && url.pathname === "/watch") {
    videoId = query.get("v");
  } else {
    if (query.has("v")) {
      return undefined;
    }
    if (url.hostname === "youtu.be") {
      videoId = /^\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)?.[1];
    } else if (YOUTUBE_HOSTS.has(url.hostname)) {
      videoId = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)?.[1];
    } else if (YOUTUBE_EMBED_HOSTS.has(url.hostname)) {
      videoId = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)?.[1];
    }
  }
  if (!videoId || !VIDEO_ID.test(videoId)) {
    return undefined;
  }
  const start = query.get("start") ?? query.get("t") ?? fragment.get("t");
  let startSeconds = 0;
  if (start !== null) {
    if (/^\d+$/u.test(start)) {
      startSeconds = Number(start);
    } else {
      const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/iu.exec(start);
      if (!units || !start) {
        return undefined;
      }
      startSeconds =
        Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
    }
    if (!Number.isSafeInteger(startSeconds) || startSeconds < 0) {
      return undefined;
    }
  }
  const watchUrl = new URL("https://www.youtube.com/watch");
  watchUrl.searchParams.set("v", videoId);
  const embedUrl = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  embedUrl.searchParams.set("playsinline", "1");
  if (startSeconds > 0) {
    watchUrl.searchParams.set("t", String(startSeconds));
    embedUrl.searchParams.set("start", String(startSeconds));
  }
  return {
    watchUrl: watchUrl.href,
    embedUrl: embedUrl.href,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}
