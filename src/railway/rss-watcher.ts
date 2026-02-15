import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const MAX_SEEN_IDS = 500;
const STATE_PATH = "/data/.openclaw/state/etsy_rss.json";

const ETSY_SHOP_RSS_URL = process.env.ETSY_SHOP_RSS_URL?.trim() ?? "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
const CHECK_INTERVAL_MS = resolveCheckIntervalMs(process.env.RSS_CHECK_INTERVAL_MS);
const HEALTH_PORT = toNumberOrUndefined(process.env.PORT) ?? 8080;
const RSS_DISABLE_HEALTH_SERVER = process.env.RSS_DISABLE_HEALTH_SERVER === "1";
let alertsEnabledMemo: boolean | null = null;

type FeedItem = {
  id: string;
  title: string;
  link: string;
  publishedAt?: string;
  publishedAtMs?: number;
};

type WatcherState = {
  seenIds: string[];
  initialized: boolean;
  telegramOffset: number;
};

type TelegramUpdatesResponse = {
  ok?: boolean;
  result?: Array<{
    update_id?: number;
    message?: {
      text?: string;
      chat?: { id?: number | string };
    };
  }>;
  description?: string;
};

let currentState: WatcherState = {
  seenIds: [],
  initialized: false,
  telegramOffset: 0,
};
let checkInFlight: Promise<void> | null = null;
let queuedManualRun = false;

function resolveCheckIntervalMs(raw: string | undefined): number {
  if (!raw) {
    return SIX_HOURS_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SIX_HOURS_MS;
  }
  return parsed;
}

function toNumberOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stripCdata(raw: string): string {
  return raw
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_match, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function findTagText(block: string, tags: string[]): string {
  for (const tag of tags) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = re.exec(block);
    if (match && match[1]) {
      return decodeXmlEntities(stripCdata(match[1]));
    }
  }
  return "";
}

function findLinkValue(block: string): string {
  const atomLink = /<link\b[^>]*\bhref="([^"]+)"[^>]*>/i.exec(block);
  if (atomLink?.[1]) {
    return decodeXmlEntities(atomLink[1].trim());
  }
  return findTagText(block, ["link"]);
}

function parseFeedItems(xml: string): FeedItem[] {
  const itemBlocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const entryBlocks = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks;

  const parsed = blocks
    .map((block) => {
      const title = findTagText(block, ["title"]).trim();
      const link = findLinkValue(block).trim();
      const id =
        findTagText(block, ["guid", "id"]).trim() ||
        link ||
        title ||
        `${Date.now()}-${Math.random()}`;
      const publishedAt =
        findTagText(block, ["pubDate", "published", "updated", "dc:date"]).trim() || undefined;
      const publishedAtMs = publishedAt ? Date.parse(publishedAt) : Number.NaN;
      return {
        id,
        title: title || "(untitled)",
        link,
        publishedAt,
        publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : undefined,
      };
    })
    .filter((item) => item.id.trim().length > 0);

  return parsed.toSorted((a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0));
}

async function loadState(): Promise<WatcherState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<WatcherState>;
    const seenIds = Array.isArray(parsed.seenIds)
      ? parsed.seenIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const initialized = parsed.initialized === true;
    const telegramOffset =
      typeof parsed.telegramOffset === "number" && Number.isFinite(parsed.telegramOffset)
        ? parsed.telegramOffset
        : 0;
    return {
      seenIds: seenIds.slice(0, MAX_SEEN_IDS),
      initialized,
      telegramOffset,
    };
  } catch {
    return {
      seenIds: [],
      initialized: false,
      telegramOffset: 0,
    };
  }
}

async function saveState(state: WatcherState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(
    STATE_PATH,
    JSON.stringify(
      {
        ...state,
        seenIds: state.seenIds.slice(0, MAX_SEEN_IDS),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function alertsEnabled(): boolean {
  if (alertsEnabledMemo !== null) {
    return alertsEnabledMemo;
  }
  if (!TELEGRAM_BOT_TOKEN) {
    alertsEnabledMemo = false;
    console.info("[rss] TELEGRAM_BOT_TOKEN missing; alerts disabled.");
    return alertsEnabledMemo;
  }
  if (!TELEGRAM_CHAT_ID) {
    alertsEnabledMemo = false;
    console.info("[rss] TELEGRAM_CHAT_ID missing; alerts disabled.");
    return alertsEnabledMemo;
  }
  alertsEnabledMemo = true;
  console.info("[rss] Telegram alerts enabled.");
  return alertsEnabledMemo;
}

async function sendTelegramText(text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: toNumberOrUndefined(TELEGRAM_CHAT_ID) ?? TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
  };

  if (!response.ok || payload.ok !== true) {
    const description = payload.description ?? `HTTP ${response.status}`;
    console.log(`[rss] Telegram send failed: ${description}`);
    if (description.toLowerCase().includes("chat not found")) {
      console.log(
        `[rss] Telegram chat not found. Verify TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID}" is numeric and belongs to this bot conversation.`,
      );
    }
    return false;
  }

  return true;
}

function formatFeedItemMessage(item: FeedItem): string {
  const lines = [`[ETSY RSS] ${item.title}`];
  if (item.link) {
    lines.push(item.link);
  }
  if (item.publishedAt) {
    lines.push(`Published: ${item.publishedAt}`);
  }
  return lines.join("\n");
}

async function fetchFeed(url: string): Promise<FeedItem[]> {
  const response = await fetch(url, {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml, */*",
    },
  });
  if (!response.ok) {
    throw new Error(`Feed request failed (HTTP ${response.status})`);
  }
  const xml = await response.text();
  return parseFeedItems(xml);
}

async function runCheck(trigger: "startup" | "scheduled" | "manual"): Promise<void> {
  if (!ETSY_SHOP_RSS_URL) {
    if (trigger === "startup") {
      console.log("[rss] ETSY_SHOP_RSS_URL is missing; watcher idle.");
    }
    return;
  }

  try {
    const items = await fetchFeed(ETSY_SHOP_RSS_URL);
    if (items.length === 0) {
      console.log(`[rss] ${trigger}: feed returned 0 items.`);
      return;
    }

    const known = new Set(currentState.seenIds);
    const newItems = items.filter((item) => !known.has(item.id));

    if (!currentState.initialized) {
      currentState.initialized = true;
      currentState.seenIds = items.map((item) => item.id).slice(0, MAX_SEEN_IDS);
      await saveState(currentState);
      console.log(`[rss] Initialized state with ${currentState.seenIds.length} items.`);
      if (trigger === "manual" && alertsEnabled()) {
        await sendTelegramText(`RSS run complete: 0 new items (initialized baseline).`);
      }
      return;
    }

    if (newItems.length === 0) {
      console.log(`[rss] ${trigger}: no new items.`);
      if (trigger === "manual" && alertsEnabled()) {
        await sendTelegramText("RSS run complete: no new items.");
      }
      return;
    }

    const sortedNew = [...newItems].toSorted(
      (a, b) => (a.publishedAtMs ?? 0) - (b.publishedAtMs ?? 0),
    );
    if (alertsEnabled()) {
      for (const item of sortedNew) {
        await sendTelegramText(formatFeedItemMessage(item));
      }
      if (trigger === "manual") {
        await sendTelegramText(`RSS run complete: ${sortedNew.length} new item(s).`);
      }
    } else {
      console.log(`[rss] ${trigger}: ${sortedNew.length} new item(s), alerts disabled.`);
    }

    const merged = [...sortedNew.map((item) => item.id), ...currentState.seenIds];
    currentState.seenIds = Array.from(new Set(merged)).slice(0, MAX_SEEN_IDS);
    await saveState(currentState);
    console.log(`[rss] ${trigger}: delivered ${sortedNew.length} new item(s).`);
  } catch (error) {
    console.log(`[rss] ${trigger} check failed: ${String(error)}`);
    if (trigger === "manual" && alertsEnabled()) {
      await sendTelegramText(`RSS run failed: ${String(error)}`);
    }
  }
}

async function scheduleCheck(trigger: "startup" | "scheduled" | "manual"): Promise<void> {
  if (checkInFlight) {
    if (trigger === "manual") {
      queuedManualRun = true;
    }
    return;
  }

  checkInFlight = runCheck(trigger)
    .catch((error) => {
      console.log(`[rss] unexpected check error: ${String(error)}`);
    })
    .finally(async () => {
      checkInFlight = null;
      if (queuedManualRun) {
        queuedManualRun = false;
        await scheduleCheck("manual");
      }
    });

  await checkInFlight;
}

async function pollTelegramForCommands(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[rss] Telegram command polling disabled (missing TELEGRAM_BOT_TOKEN).");
    return;
  }
  if (!TELEGRAM_CHAT_ID) {
    console.log("[rss] Telegram command polling disabled (missing TELEGRAM_CHAT_ID).");
    return;
  }

  while (true) {
    try {
      const params = new URLSearchParams({
        timeout: String(TELEGRAM_POLL_TIMEOUT_SECONDS),
        allowed_updates: JSON.stringify(["message"]),
      });
      if (currentState.telegramOffset > 0) {
        params.set("offset", String(currentState.telegramOffset));
      }

      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${params.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`getUpdates failed (HTTP ${response.status})`);
      }

      const payload = (await response.json()) as TelegramUpdatesResponse;
      if (!payload.ok) {
        throw new Error(payload.description || "getUpdates failed");
      }

      const updates = payload.result ?? [];
      for (const update of updates) {
        const updateId = update.update_id;
        if (typeof updateId === "number") {
          currentState.telegramOffset = Math.max(currentState.telegramOffset, updateId + 1);
        }

        const text = update.message?.text?.trim() ?? "";
        const chatIdRaw = update.message?.chat?.id;
        const incomingChatId =
          typeof chatIdRaw === "number" || typeof chatIdRaw === "string" ? String(chatIdRaw) : "";
        if (!incomingChatId || incomingChatId !== TELEGRAM_CHAT_ID) {
          continue;
        }
        if (!text.startsWith("/rss_run")) {
          continue;
        }

        await sendTelegramText("Running RSS check now.");
        await scheduleCheck("manual");
      }

      await saveState(currentState);
    } catch (error) {
      console.log(`[rss] Telegram poll failed: ${String(error)}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

async function main(): Promise<void> {
  if (!RSS_DISABLE_HEALTH_SERVER) {
    const healthServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    });
    await new Promise<void>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
        console.log(`[rss] health server listening on http://0.0.0.0:${HEALTH_PORT}/health`);
        resolve();
      });
    });
  }

  console.log(
    `RSS watcher boot: ETSY_SHOP_RSS_URL present=${ETSY_SHOP_RSS_URL ? "yes" : "no"}, state_path=${STATE_PATH}`,
  );
  currentState = await loadState();
  await saveState(currentState);

  await scheduleCheck("startup");
  setInterval(() => {
    void scheduleCheck("scheduled");
  }, CHECK_INTERVAL_MS).unref();
  void pollTelegramForCommands();
}

void main().catch((error) => {
  console.error(`[rss] fatal startup error: ${String(error)}`);
  process.exitCode = 1;
});
