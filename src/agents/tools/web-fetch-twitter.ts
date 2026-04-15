/**
 * Twitter/X URL detection and FxTwitter API fallback.
 *
 * Twitter/X pages return login walls to non-browser user agents, making
 * `web_fetch` useless for tweet URLs.  This module rewrites tweet URLs to
 * the public FxTwitter JSON API (`api.fxtwitter.com`) which returns tweet
 * content without authentication.
 */

const TWITTER_HOST_RE = /^(?:www\.)?(?:twitter\.com|x\.com)$/i;
const TWEET_STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

export function isTwitterStatusUrl(url: URL): boolean {
  return TWITTER_HOST_RE.test(url.hostname) && TWEET_STATUS_RE.test(url.pathname);
}

/**
 * Rewrite a twitter.com / x.com tweet URL to an api.fxtwitter.com URL.
 * Returns `null` when the URL is not a recognised tweet link.
 */
export function rewriteToFxTwitterApi(url: URL): string | null {
  if (!TWITTER_HOST_RE.test(url.hostname)) {
    return null;
  }
  const match = url.pathname.match(TWEET_STATUS_RE);
  if (!match) {
    return null;
  }
  const [, user, statusId] = match;
  return `https://api.fxtwitter.com/${user}/status/${statusId}`;
}

export type FxTwitterTweet = {
  text: string;
  author: { name: string; screen_name: string };
  created_at: string;
  media?: { url: string; type: string }[];
  likes: number;
  retweets: number;
  replies: number;
};

/**
 * Fetch a tweet via the FxTwitter JSON API.  Returns a formatted markdown
 * string on success, or `null` on any failure.
 */
export async function fetchTweetViaFxTwitter(
  originalUrl: string,
  timeoutMs: number = 10_000,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return null;
  }

  const apiUrl = rewriteToFxTwitterApi(parsed);
  if (!apiUrl) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { code?: number; tweet?: FxTwitterTweet };
    if (!data.tweet) {
      return null;
    }

    const t = data.tweet;
    const lines: string[] = [
      `**${t.author.name}** (@${t.author.screen_name})`,
      `${t.created_at}`,
      "",
      t.text,
      "",
      `❤️ ${t.likes}  🔁 ${t.retweets}  💬 ${t.replies}`,
    ];

    if (t.media?.length) {
      lines.push("");
      for (const m of t.media) {
        lines.push(`[${m.type}: ${m.url}]`);
      }
    }

    lines.push("", `Source: ${originalUrl}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}
