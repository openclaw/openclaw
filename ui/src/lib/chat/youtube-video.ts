export type YouTubeVideo = {
  videoId: string;
  startSeconds: number;
  watchUrl: string;
  embedUrl: string;
  thumbnailUrl: string;
};

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTUBE_EMBED_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;

function parseStartSeconds(value: string | null): number | undefined {
  if (value === null) {
    return 0;
  }
  let seconds: number;
  if (/^\d+$/u.test(value)) {
    seconds = Number(value);
  } else {
    const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/iu.exec(value);
    if (!units || !value) {
      return undefined;
    }
    seconds = Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Resolves supported video links into fixed YouTube player and image origins. */
export function parseYouTubeVideoUrl(raw: string | undefined): YouTubeVideo | undefined {
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
  let videoId: string | undefined;
  if (YOUTUBE_HOSTS.has(url.hostname) && url.pathname === "/watch") {
    videoId = query.get("v") ?? undefined;
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
  const startSeconds = parseStartSeconds(query.get("start") ?? query.get("t") ?? fragment.get("t"));
  if (startSeconds === undefined) {
    return undefined;
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
    videoId,
    startSeconds,
    watchUrl: watchUrl.href,
    embedUrl: embedUrl.href,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}
