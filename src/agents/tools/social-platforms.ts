import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { stringEnum } from "../schema/typebox.js";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
  readStringArrayParam,
  ToolInputError,
} from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  withTimeout,
  writeCache,
} from "./web-shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOCIAL_PLATFORMS = ["instagram", "tiktok", "youtube"] as const;
type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

const INSTAGRAM_MODES = ["url", "search"] as const;
const INSTAGRAM_URL_TYPES = ["posts", "comments", "mentions", "urls"] as const;
const INSTAGRAM_SEARCH_TYPES = ["hashtags", "places", "users"] as const;
const TIKTOK_TYPES = ["search", "hashtags", "videos", "profiles"] as const;

const DEFAULT_APIFY_BASE_URL = "https://api.apify.com";
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULT_CHARS = 50_000;
const HTTP_TIMEOUT_MS = 30_000;

const ACTOR_IDS: Record<SocialPlatform, string> = {
  instagram: "shu8hvrXbJbY3Eb9W",
  tiktok: "GdWCkxBtKWOsKjdch",
  youtube: "h7sDV53CddomktSi5",
};

const SOCIAL_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RequestSchema = Type.Object({
  platform: stringEnum(SOCIAL_PLATFORMS, {
    description: "Social media platform to scrape.",
  }),
  instagramMode: Type.Optional(
    stringEnum(INSTAGRAM_MODES, {
      description: "Instagram: 'url' to scrape direct URLs, 'search' to search by query.",
    }),
  ),
  instagramType: Type.Optional(
    stringEnum([...INSTAGRAM_URL_TYPES, ...INSTAGRAM_SEARCH_TYPES] as const, {
      description:
        "Instagram data type. URL mode: posts, comments, mentions, urls. Search mode: hashtags, places, users.",
    }),
  ),
  tiktokType: Type.Optional(
    stringEnum(TIKTOK_TYPES, {
      description: "TikTok input type: search queries, hashtags, video URLs, or profiles.",
    }),
  ),
  urls: Type.Optional(
    Type.Array(Type.String(), {
      description: "URLs to scrape (Instagram URLs, TikTok video URLs, YouTube URLs).",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      description: "Search terms (Instagram search, TikTok search, YouTube search).",
    }),
  ),
  hashtags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Hashtags to scrape (TikTok).",
    }),
  ),
  profiles: Type.Optional(
    Type.Array(Type.String(), {
      description: "Profile usernames (TikTok profiles).",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 20).",
      minimum: 1,
      maximum: 100,
    }),
  ),
  actorInput: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Additional platform-specific Actor input parameters merged into the Actor input. " +
        "Use this to fine-tune scraping behavior (filters, downloads, sorting, etc.). " +
        "See platform-specific options in the tool description.",
    }),
  ),
});

const RunRefSchema = Type.Object({
  runId: Type.String({ description: "Apify run ID from start response." }),
  platform: stringEnum(SOCIAL_PLATFORMS, { description: "Platform of this run." }),
  datasetId: Type.String({ description: "Dataset ID from start response." }),
});

const SocialPlatformsSchema = Type.Object({
  action: stringEnum(["start", "collect"] as const, {
    description:
      "'start': fire off scraping jobs concurrently, returns immediately with run IDs. " +
      "'collect': fetch results for previously started runs.",
  }),
  requests: Type.Optional(
    Type.Array(RequestSchema, {
      description:
        "Scraping requests (for 'start' action). Each specifies a platform and its parameters.",
    }),
  ),
  runs: Type.Optional(
    Type.Array(RunRefSchema, {
      description: "Run references from 'start' response (for 'collect' action).",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

type SocialConfig = NonNullable<OpenClawConfig["tools"]>["social"];

function resolveSocialConfig(cfg?: OpenClawConfig): SocialConfig {
  return cfg?.tools?.social;
}

function resolveSocialApiKey(config?: SocialConfig): string | undefined {
  const fromConfig =
    config && typeof config.apiKey === "string" ? normalizeSecretInput(config.apiKey) : "";
  const fromEnv = normalizeSecretInput(process.env.APIFY_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveSocialEnabled(params: { config?: SocialConfig; apiKey?: string }): boolean {
  if (typeof params.config?.enabled === "boolean") {
    return params.config.enabled;
  }
  return Boolean(params.apiKey);
}

function resolveSocialBaseUrl(config?: SocialConfig): string {
  const raw = config && typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  return raw || DEFAULT_APIFY_BASE_URL;
}

function resolveAllowedPlatforms(config?: SocialConfig): Set<SocialPlatform> {
  const list = config?.allowedPlatforms;
  if (Array.isArray(list) && list.length > 0) {
    return new Set(list.filter((p): p is SocialPlatform => SOCIAL_PLATFORMS.includes(p as never)));
  }
  return new Set(SOCIAL_PLATFORMS);
}

function resolveMaxResults(config?: SocialConfig): number {
  const raw = config?.maxResults;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(100, Math.floor(raw));
  }
  return DEFAULT_MAX_RESULTS;
}

// ---------------------------------------------------------------------------
// Per-platform input builders
// ---------------------------------------------------------------------------

function buildInstagramInput(params: {
  mode: string;
  type: string;
  urls?: string[];
  queries?: string[];
  maxResults: number;
}): Record<string, unknown> {
  if (params.mode === "url") {
    if (!params.urls?.length) {
      throw new ToolInputError("Instagram URL mode requires 'urls' parameter.");
    }
    return {
      directUrls: params.urls,
      resultsType: params.type === "urls" ? "posts" : params.type,
      resultsLimit: params.maxResults,
    };
  }
  // search mode
  if (!params.queries?.length) {
    throw new ToolInputError("Instagram search mode requires 'queries' parameter.");
  }
  return {
    search: params.queries[0],
    searchType: params.type,
    searchLimit: params.maxResults,
    resultsType: "posts",
    resultsLimit: params.maxResults,
  };
}

function buildTiktokInput(params: {
  type: string;
  queries?: string[];
  hashtags?: string[];
  urls?: string[];
  profiles?: string[];
  maxResults: number;
}): Record<string, unknown> {
  const base = {
    resultsPerPage: params.maxResults,
    shouldDownloadVideos: false,
    shouldDownloadSubtitles: false,
    shouldDownloadCovers: false,
    shouldDownloadAvatars: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadMusicCovers: false,
  };
  switch (params.type) {
    case "search":
      if (!params.queries?.length) {
        throw new ToolInputError("TikTok search requires 'queries' parameter.");
      }
      return { ...base, searchQueries: params.queries };
    case "hashtags":
      if (!params.hashtags?.length) {
        throw new ToolInputError("TikTok hashtags requires 'hashtags' parameter.");
      }
      return { ...base, hashtags: params.hashtags };
    case "videos":
      if (!params.urls?.length) {
        throw new ToolInputError("TikTok videos requires 'urls' parameter.");
      }
      return { ...base, videoUrls: params.urls };
    case "profiles":
      if (!params.profiles?.length) {
        throw new ToolInputError("TikTok profiles requires 'profiles' parameter.");
      }
      return { ...base, profiles: params.profiles, profileScrapeSections: ["videos"] };
    default:
      throw new ToolInputError(`Unknown TikTok type: ${params.type}`);
  }
}

function buildYoutubeInput(params: {
  urls?: string[];
  queries?: string[];
  maxResults: number;
}): Record<string, unknown> {
  if (params.urls?.length) {
    return {
      startUrls: params.urls.map((url) => ({ url })),
      maxResults: params.maxResults,
    };
  }
  if (params.queries?.length) {
    return {
      searchKeywords: params.queries.join(", "),
      maxResults: params.maxResults,
    };
  }
  throw new ToolInputError("YouTube requires 'urls' or 'queries' parameter.");
}

// ---------------------------------------------------------------------------
// Apify async API helpers
// ---------------------------------------------------------------------------

interface ApifyRunInfo {
  id: string;
  defaultDatasetId: string;
  status: string;
}

async function startApifyActorRun(params: {
  actorId: string;
  input: Record<string, unknown>;
  apiKey: string;
  baseUrl: string;
}): Promise<ApifyRunInfo> {
  const endpoint = `${params.baseUrl}/v2/acts/${params.actorId}/runs`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(params.input),
    signal: withTimeout(undefined, HTTP_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(
      `Failed to start Apify actor (${res.status}): ${detail.text || res.statusText}`,
    );
  }

  const body = (await res.json()) as { data: ApifyRunInfo };
  return body.data;
}

async function getApifyRunStatus(params: {
  runId: string;
  apiKey: string;
  baseUrl: string;
}): Promise<{ status: string; defaultDatasetId: string }> {
  const endpoint = `${params.baseUrl}/v2/actor-runs/${params.runId}`;

  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${params.apiKey}` },
    signal: withTimeout(undefined, HTTP_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(`Failed to get run status (${res.status}): ${detail.text || res.statusText}`);
  }

  const body = (await res.json()) as {
    data: { status: string; defaultDatasetId: string };
  };
  return body.data;
}

async function getApifyDatasetItems(params: {
  datasetId: string;
  apiKey: string;
  baseUrl: string;
}): Promise<unknown[]> {
  const endpoint = `${params.baseUrl}/v2/datasets/${params.datasetId}/items`;

  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${params.apiKey}` },
    signal: withTimeout(undefined, HTTP_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(
      `Failed to get dataset items (${res.status}): ${detail.text || res.statusText}`,
    );
  }

  return (await res.json()) as unknown[];
}

// ---------------------------------------------------------------------------
// Result formatters
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value as string | number | boolean);
}

function num(value: unknown): string {
  if (typeof value === "number") {
    return value.toLocaleString();
  }
  return str(value);
}

function formatInstagramItem(item: Record<string, unknown>): string {
  const lines: string[] = [`## Instagram Post by @${str(item.ownerUsername)}`];
  if (item.url) {
    lines.push(`**URL**: ${str(item.url)}`);
  }
  if (item.type) {
    lines.push(`**Type**: ${str(item.type)}`);
  }
  const stats: string[] = [];
  if (item.likesCount !== undefined) {
    stats.push(`Likes: ${num(item.likesCount)}`);
  }
  if (item.commentsCount !== undefined) {
    stats.push(`Comments: ${num(item.commentsCount)}`);
  }
  if (stats.length) {
    lines.push(`**${stats.join(" | ")}**`);
  }
  if (item.caption) {
    lines.push(`**Caption**: ${str(item.caption)}`);
  }
  if (item.timestamp) {
    lines.push(`**Posted**: ${str(item.timestamp)}`);
  }
  return lines.join("\n");
}

function formatTiktokItem(item: Record<string, unknown>): string {
  const author =
    item.authorMeta && typeof item.authorMeta === "object"
      ? (item.authorMeta as Record<string, unknown>).name
      : item.author;
  const lines: string[] = [`## TikTok Video by @${str(author)}`];
  if (item.webVideoUrl) {
    lines.push(`**URL**: ${str(item.webVideoUrl)}`);
  }
  const stats: string[] = [];
  if (item.playCount !== undefined) {
    stats.push(`Plays: ${num(item.playCount)}`);
  }
  if (item.diggCount !== undefined) {
    stats.push(`Likes: ${num(item.diggCount)}`);
  }
  if (item.shareCount !== undefined) {
    stats.push(`Shares: ${num(item.shareCount)}`);
  }
  if (item.commentCount !== undefined) {
    stats.push(`Comments: ${num(item.commentCount)}`);
  }
  if (stats.length) {
    lines.push(`**${stats.join(" | ")}**`);
  }
  if (item.text) {
    lines.push(`**Description**: ${str(item.text)}`);
  }
  const videoMeta = item.videoMeta as Record<string, unknown> | undefined;
  if (videoMeta?.duration) {
    lines.push(`**Duration**: ${num(videoMeta.duration)}s`);
  }
  if (item.createTimeISO) {
    lines.push(`**Posted**: ${str(item.createTimeISO)}`);
  }
  return lines.join("\n");
}

function formatYoutubeItem(item: Record<string, unknown>): string {
  const lines: string[] = [`## ${str(item.title)}`];
  if (item.url) {
    lines.push(`**URL**: ${str(item.url)}`);
  }
  if (item.channelName) {
    const subs = item.numberOfSubscribers ? ` (${num(item.numberOfSubscribers)} subscribers)` : "";
    lines.push(`**Channel**: ${str(item.channelName)}${subs}`);
  }
  const stats: string[] = [];
  if (item.viewCount !== undefined) {
    stats.push(`Views: ${num(item.viewCount)}`);
  }
  if (item.likes !== undefined) {
    stats.push(`Likes: ${num(item.likes)}`);
  }
  if (stats.length) {
    lines.push(`**${stats.join(" | ")}**`);
  }
  if (item.duration) {
    lines.push(`**Duration**: ${str(item.duration)}`);
  }
  if (item.date) {
    lines.push(`**Published**: ${str(item.date)}`);
  }
  if (item.text) {
    lines.push(`**Description**: ${str(item.text)}`);
  }
  return lines.join("\n");
}

function formatPlatformResults(platform: SocialPlatform, items: unknown[]): string {
  const formatter =
    platform === "instagram"
      ? formatInstagramItem
      : platform === "tiktok"
        ? formatTiktokItem
        : formatYoutubeItem;

  const parts = items.map((item) => {
    try {
      return formatter(item as Record<string, unknown>);
    } catch {
      return `## [unreadable item]\n${JSON.stringify(item).slice(0, 200)}`;
    }
  });

  const text = parts.join("\n\n---\n\n");
  if (text.length > MAX_RESULT_CHARS) {
    return text.slice(0, MAX_RESULT_CHARS) + "\n\n[…truncated]";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tool description builder
// ---------------------------------------------------------------------------

function buildToolDescription(allowed: Set<SocialPlatform>): string {
  const lines = [
    "Scrape structured data from social media platforms via Apify.",
    "Always prefer this tool over web_fetch for Instagram, TikTok, and YouTube data.",
    "",
    "TWO-PHASE ASYNC PATTERN:",
    '1. Call with action="start" and a requests array → fires off all scraping jobs concurrently, returns immediately with run IDs.',
    "2. Do other work (reasoning, other tool calls, etc.).",
    '3. Call with action="collect" and the runs array from step 1 → fetches results for completed runs, reports pending ones.',
    "",
    "START ACTION:",
    '  action: "start"',
    "  requests: array of request objects (one per scraping job, no limit per platform). Each request has:",
    '    - platform (required): "instagram" | "tiktok" | "youtube"',
    "    - platform-specific parameters (see below)",
    "    - maxResults (optional, 1-100, default 20)",
    "",
    "COLLECT ACTION:",
    '  action: "collect"',
    "  runs: array of { runId, platform, datasetId } objects from the start response.",
    "  Returns completed results + lists any still-pending runs. Call again if runs are pending.",
    "",
  ];

  if (allowed.has("instagram")) {
    lines.push(
      'INSTAGRAM (platform="instagram"):',
      "  Requires: instagramMode + instagramType.",
      '  Mode "url" — scrape direct Instagram URLs:',
      "    instagramType: posts | comments | mentions | urls",
      "    Requires: urls (array of Instagram post/profile/reel URLs)",
      '  Mode "search" — search Instagram by keyword:',
      "    instagramType: hashtags | places | users",
      "    Requires: queries (array of search terms)",
      "  actorInput options for Instagram:",
      "    resultsType: string — what to scrape: posts | comments | details | mentions | reels (default: posts)",
      "    resultsLimit: number — max results per URL (default: 200)",
      '    onlyPostsNewerThan: string — date filter, e.g. "2024-01-01" or "7 days"',
      "    searchType: string — search type: user | hashtag | place (default: hashtag)",
      "    searchLimit: number — max search results (1-250, default: 1)",
      "    addParentData: boolean — add source metadata to results (default: false)",
      "",
    );
  }

  if (allowed.has("tiktok")) {
    lines.push(
      'TIKTOK (platform="tiktok"):',
      "  Requires: tiktokType + the matching input array.",
      '  tiktokType="search"   → requires queries',
      '  tiktokType="hashtags" → requires hashtags (without # prefix)',
      '  tiktokType="videos"   → requires urls (TikTok video URLs)',
      '  tiktokType="profiles" → requires profiles (usernames without @)',
      "  actorInput options for TikTok:",
      "    resultsPerPage: number — results per hashtag/profile/search (1-1000000, default: 100)",
      "    profileScrapeSections: string[] — sections to scrape: videos | reposts (default: [videos])",
      "    profileSorting: string — sort profile content: latest | popular | oldest (default: latest)",
      "    excludePinnedPosts: boolean — exclude pinned posts from profiles (default: false)",
      '    oldestPostDateUnified: string — date filter for profile videos, e.g. "2024-01-01" or "30 days"',
      '    newestPostDate: string — scrape videos published before this date, e.g. "2025-01-01"',
      "    leastDiggs: number — min hearts filter (popularity filter)",
      "    mostDiggs: number — max hearts filter (popularity filter)",
      '    searchSection: string — filter search results: "" (Top) | "/video" (Video) | "/user" (Profile)',
      "    maxProfilesPerQuery: number — max profiles for profile searches (default: 10)",
      '    searchSorting: string — sort search results: "0" (relevant) | "1" (most liked) | "3" (latest)',
      '    searchDatePosted: string — search date range: "0" (all time) | "1" (24h) | "2" (week) | "3" (month) | "4" (3 months) | "5" (6 months)',
      "    scrapeRelatedVideos: boolean — scrape related videos for postURLs (default: false)",
      "    shouldDownloadVideos: boolean — download TikTok videos (charged add-on, default: false)",
      "    shouldDownloadSubtitles: boolean — download subtitles (default: false)",
      "    shouldDownloadCovers: boolean — download thumbnails (default: false)",
      "    shouldDownloadAvatars: boolean — download profile avatars (default: false)",
      "    shouldDownloadSlideshowImages: boolean — download slideshow images (default: false)",
      "    shouldDownloadMusicCovers: boolean — download sound covers (default: false)",
      "    commentsPerPost: number — max comments per post (0 = none)",
      "    maxRepliesPerComment: number — max replies per comment (0 = none)",
      "    maxFollowersPerProfile: number — scrape follower profiles (0 = none, charged)",
      "    maxFollowingPerProfile: number — scrape following profiles (0 = none, charged)",
      "    proxyCountryCode: string — ISO country code for proxy, e.g. 'US', 'GB' (default: None)",
      "",
    );
  }

  if (allowed.has("youtube")) {
    lines.push(
      'YOUTUBE (platform="youtube"):',
      "  Provide either urls or queries. At least one is required.",
      "  actorInput options for YouTube:",
      "    maxResults: number — max videos per search term (default: 10)",
      "    maxResultsShorts: number — max shorts per search (default: 0)",
      "    maxResultStreams: number — max streams per search (default: 0)",
      "    downloadSubtitles: boolean — download video subtitles in SRT format (default: false)",
      "    subtitlesLanguage: string — subtitle language: any | en | de | es | fr | it | ja | ko | nl | pt | ru (default: en)",
      "    subtitlesFormat: string — subtitle format: srt | vtt | xml | plaintext (default: srt)",
      "    preferAutoGeneratedSubtitles: boolean — prefer auto-generated over user subtitles (default: false)",
      "    saveSubsToKVS: boolean — save subtitles to key-value store (default: false)",
      "    sortingOrder: string — sort search results: relevance | rating | date | views",
      "    dateFilter: string — upload date filter: hour | today | week | month | year",
      "    videoType: string — video type filter: video | movie",
      "    lengthFilter: string — length filter: under4 | between420 | plus20",
      "    isHD: boolean — HD filter | is4K: boolean — 4K filter | isLive: boolean — Live filter",
      "    hasSubtitles: boolean — Subtitles/CC filter | hasCC: boolean — Creative Commons filter",
      '    oldestPostDate: string — scrape channel videos after this date, e.g. "2024-01-01" or "30 days"',
      "    sortVideosBy: string — sort channel videos: NEWEST | POPULAR | OLDEST",
      "",
    );
  }

  lines.push(
    "EXAMPLE — scrape Instagram and TikTok concurrently:",
    '  { action: "start", requests: [',
    '    { platform: "instagram", instagramMode: "search", instagramType: "hashtags", queries: ["sunset"] },',
    '    { platform: "tiktok", tiktokType: "search", queries: ["AI tools"], actorInput: { searchSection: "/video", searchSorting: "3" } }',
    "  ]}",
    "  → returns { runs: [{ runId, platform, datasetId }, ...] }",
    '  Then: { action: "collect", runs: <runs from above> }',
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core logic — start
// ---------------------------------------------------------------------------

async function handleStart(params: {
  requests: Record<string, unknown>[];
  allowedPlatforms: Set<SocialPlatform>;
  apiKey: string;
  baseUrl: string;
  defaultMaxResults: number;
}): Promise<Record<string, unknown>> {
  if (!params.requests?.length) {
    throw new ToolInputError("'start' action requires 'requests' array with at least one request.");
  }

  // Build all inputs up-front so validation errors fail fast before any API calls.
  const prepared: {
    platform: SocialPlatform;
    actorId: string;
    input: Record<string, unknown>;
  }[] = [];

  for (const req of params.requests) {
    const platform = readStringParam(req, "platform", { required: true }) as SocialPlatform;
    if (!params.allowedPlatforms.has(platform)) {
      throw new ToolInputError(`Platform "${platform}" is not enabled.`);
    }

    const maxResults = readNumberParam(req, "maxResults") ?? params.defaultMaxResults;
    const urls = readStringArrayParam(req, "urls");
    const queries = readStringArrayParam(req, "queries");
    const hashtags = readStringArrayParam(req, "hashtags");
    const profiles = readStringArrayParam(req, "profiles");
    const actorId = ACTOR_IDS[platform];

    const actorInput =
      req.actorInput && typeof req.actorInput === "object" && !Array.isArray(req.actorInput)
        ? (req.actorInput as Record<string, unknown>)
        : {};

    let input: Record<string, unknown>;
    switch (platform) {
      case "instagram": {
        const mode = readStringParam(req, "instagramMode", { required: true });
        const type = readStringParam(req, "instagramType", { required: true });
        input = {
          ...buildInstagramInput({ mode, type, urls, queries, maxResults }),
          ...actorInput,
        };
        break;
      }
      case "tiktok": {
        const type = readStringParam(req, "tiktokType", { required: true });
        input = {
          ...buildTiktokInput({ type, queries, hashtags, urls, profiles, maxResults }),
          ...actorInput,
        };
        break;
      }
      case "youtube": {
        input = { ...buildYoutubeInput({ urls, queries, maxResults }), ...actorInput };
        break;
      }
    }

    prepared.push({ platform, actorId, input });
  }

  // Fire all Actor starts concurrently.
  const results = await Promise.allSettled(
    prepared.map(async ({ platform, actorId, input }) => {
      const run = await startApifyActorRun({
        actorId,
        input,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      });
      return {
        platform,
        runId: run.id,
        datasetId: run.defaultDatasetId,
        status: run.status,
      };
    }),
  );

  const runs: { runId: string; platform: SocialPlatform; datasetId: string; status: string }[] = [];
  const errors: { index: number; platform: string; error: string }[] = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      runs.push(result.value);
    } else {
      errors.push({
        index: i,
        platform: prepared[i].platform,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return {
    action: "start",
    message:
      `Started ${runs.length} scraping job(s)` +
      (errors.length ? `, ${errors.length} failed to start` : "") +
      ". Use action 'collect' with the runs array to fetch results.",
    runs,
    ...(errors.length ? { errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core logic — collect
// ---------------------------------------------------------------------------

async function handleCollect(params: {
  runs: Record<string, unknown>[];
  apiKey: string;
  baseUrl: string;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  if (!params.runs?.length) {
    throw new ToolInputError("'collect' action requires 'runs' array.");
  }

  const results = await Promise.allSettled(
    params.runs.map(async (runRef) => {
      const runId = readStringParam(runRef, "runId", { required: true });
      const platform = readStringParam(runRef, "platform", {
        required: true,
      }) as SocialPlatform;
      const datasetId = readStringParam(runRef, "datasetId", { required: true });

      // Return from cache if we already fetched this run.
      const cacheKey = normalizeCacheKey(`social:run:${runId}`);
      const cached = readCache(SOCIAL_CACHE, cacheKey);
      if (cached) {
        return { ...cached.value, cached: true };
      }

      // Check run status.
      const runStatus = await getApifyRunStatus({
        runId,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      });

      if (!TERMINAL_STATUSES.has(runStatus.status)) {
        return {
          platform,
          runId,
          status: runStatus.status,
          pending: true,
        } as Record<string, unknown>;
      }

      if (runStatus.status !== "SUCCEEDED") {
        return {
          platform,
          runId,
          status: runStatus.status,
          error: `Run ended with status: ${runStatus.status}`,
        } as Record<string, unknown>;
      }

      // Fetch dataset items.
      const items = await getApifyDatasetItems({
        datasetId,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      });

      const text = formatPlatformResults(platform, items);
      const wrapped = wrapExternalContent(text, {
        source: "social_platforms",
        includeWarning: true,
      });

      const payload: Record<string, unknown> = {
        platform,
        runId,
        status: "SUCCEEDED",
        resultCount: items.length,
        text: wrapped,
        externalContent: { untrusted: true, source: "social_platforms", wrapped: true },
        fetchedAt: new Date().toISOString(),
      };

      writeCache(SOCIAL_CACHE, cacheKey, payload, params.cacheTtlMs);
      return payload;
    }),
  );

  const completed: Record<string, unknown>[] = [];
  const pending: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      errors.push({
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      continue;
    }
    const value = result.value;
    if (value.pending) {
      pending.push(value);
    } else if (value.error) {
      errors.push(value);
    } else {
      completed.push(value);
    }
  }

  return {
    action: "collect",
    allDone: pending.length === 0,
    message:
      pending.length === 0
        ? `All ${completed.length} run(s) completed.`
        : `${completed.length} completed, ${pending.length} still running. Call collect again for pending runs.`,
    completed,
    ...(pending.length ? { pending } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main tool factory
// ---------------------------------------------------------------------------

export function createSocialPlatformsTool(options?: {
  config?: OpenClawConfig;
}): AnyAgentTool | null {
  const config = resolveSocialConfig(options?.config);
  const apiKey = resolveSocialApiKey(config);
  if (!resolveSocialEnabled({ config, apiKey })) {
    return null;
  }

  const allowedPlatforms = resolveAllowedPlatforms(config);
  const baseUrl = resolveSocialBaseUrl(config);
  const defaultMaxResults = resolveMaxResults(config);
  const cacheTtlMs = resolveCacheTtlMs(config?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
  const description = buildToolDescription(allowedPlatforms);

  return {
    label: "Social Platforms",
    name: "social_platforms",
    description,
    parameters: SocialPlatformsSchema,
    execute: async (_toolCallId, args) => {
      const typedArgs = args as Record<string, unknown>;
      const action = readStringParam(typedArgs, "action", { required: true });

      if (!apiKey) {
        return jsonResult({
          error: "missing_api_key",
          message: "Set APIFY_API_KEY env var or tools.social.apiKey in config.",
          docs: "https://docs.openclaw.ai/tools/social",
        });
      }

      switch (action) {
        case "start":
          return jsonResult(
            await handleStart({
              requests: typedArgs.requests as Record<string, unknown>[],
              allowedPlatforms,
              apiKey,
              baseUrl,
              defaultMaxResults,
            }),
          );
        case "collect":
          return jsonResult(
            await handleCollect({
              runs: typedArgs.runs as Record<string, unknown>[],
              apiKey,
              baseUrl,
              cacheTtlMs,
            }),
          );
        default:
          throw new ToolInputError(`Unknown action: "${action}". Use "start" or "collect".`);
      }
    },
  };
}
