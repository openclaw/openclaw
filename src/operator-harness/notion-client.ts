import type { NotionPageEntry } from "./types.js";

const DEFAULT_NOTION_VERSION = "2022-06-28";

type NotionConfig = {
  authEnv?: string;
  version?: string;
};

type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

type NotionPageResponse = {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
};

type NotionSearchResponse = {
  results: Array<{
    object: string;
    id: string;
    url?: string;
    properties?: Record<string, unknown>;
  }>;
};

function normalizeUuid(value: string) {
  const trimmed = value.trim().replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(trimmed)) {
    return null;
  }
  return `${trimmed.slice(0, 8)}-${trimmed.slice(8, 12)}-${trimmed.slice(12, 16)}-${trimmed.slice(16, 20)}-${trimmed.slice(20)}`.toLowerCase();
}

export function extractNotionPageId(input: string) {
  const trimmed = input.trim();
  const direct = normalizeUuid(trimmed);
  if (direct) {
    return direct;
  }
  try {
    const url = new URL(trimmed);
    const candidate = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const idMatch = candidate.match(/([0-9a-fA-F]{32})$/);
    if (idMatch?.[1]) {
      return normalizeUuid(idMatch[1]);
    }
  } catch {
    return null;
  }
  return null;
}

function readEnv(name?: string) {
  if (!name) {
    return undefined;
  }
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function resolveNotionToken(config: NotionConfig) {
  const candidates = [
    config.authEnv,
    "OPENCLAW_SKILL_NOTION_API_KEY",
    "NOTION_API_KEY",
    "NOTION_TOKEN",
  ];
  for (const name of candidates) {
    const value = readEnv(name);
    if (value) {
      return value;
    }
  }
  throw new Error(
    `Notion token is required for operator intake (checked ${candidates.filter(Boolean).join(", ")})`,
  );
}

function richTextToPlainText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) =>
      typeof item === "object" && item && "plain_text" in item
        ? stringValue((item as { plain_text?: unknown }).plain_text)
        : "",
    )
    .join("")
    .trim();
}

function propertyPlainText(property: unknown): string {
  if (!property || typeof property !== "object") {
    return "";
  }
  const typed = property as Record<string, unknown>;
  switch (typed.type) {
    case "title":
      return richTextToPlainText(typed.title);
    case "rich_text":
      return richTextToPlainText(typed.rich_text);
    case "url":
      return typeof typed.url === "string" ? typed.url.trim() : "";
    case "checkbox":
      return typed.checkbox === true ? "true" : typed.checkbox === false ? "false" : "";
    case "select":
      return typeof typed.select === "object" && typed.select
        ? stringValue((typed.select as { name?: unknown }).name).trim()
        : "";
    default:
      return "";
  }
}

function pickPropertyText(properties: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = propertyPlainText(properties[name]);
    if (value) {
      return value;
    }
  }
  return "";
}

function firstNonEmptyLine(markdown: string) {
  return (
    markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ?? ""
  );
}

function blockText(block: NotionBlock): string {
  const payload =
    typeof block[block.type] === "object" && block[block.type]
      ? (block[block.type] as Record<string, unknown>)
      : {};
  const text = richTextToPlainText(payload.rich_text);
  if (text) {
    return text;
  }
  if (block.type === "child_page") {
    return stringValue(payload.title).trim();
  }
  if (block.type === "bookmark" || block.type === "link_preview") {
    return stringValue(payload.url).trim();
  }
  return "";
}

function blockMarkdown(block: NotionBlock): string[] {
  const text = blockText(block);
  switch (block.type) {
    case "heading_1":
      return text ? [`# ${text}`] : [];
    case "heading_2":
      return text ? [`## ${text}`] : [];
    case "heading_3":
      return text ? [`### ${text}`] : [];
    case "bulleted_list_item":
      return text ? [`- ${text}`] : [];
    case "numbered_list_item":
      return text ? [`1. ${text}`] : [];
    case "to_do": {
      const payload =
        typeof block[block.type] === "object" && block[block.type]
          ? (block[block.type] as Record<string, unknown>)
          : {};
      const checked = payload.checked === true ? "x" : " ";
      return text ? [`- [${checked}] ${text}`] : [];
    }
    case "image": {
      const payload =
        typeof block[block.type] === "object" && block[block.type]
          ? (block[block.type] as Record<string, unknown>)
          : {};
      const source =
        typeof payload.type === "string" &&
        payload[payload.type] &&
        typeof payload[payload.type] === "object"
          ? stringValue((payload[payload.type] as { url?: unknown }).url).trim()
          : "";
      return source ? [`![image](${source})`] : [];
    }
    default:
      return text ? [text] : [];
  }
}

function extractImageRefs(blocks: NotionBlock[], properties: Record<string, unknown>) {
  const refs = new Set<string>();
  const propertyImagePath = pickPropertyText(properties, ["Image Path"]);
  if (propertyImagePath) {
    refs.add(propertyImagePath);
  }
  for (const block of blocks) {
    if (block.type !== "image") {
      continue;
    }
    const payload =
      typeof block[block.type] === "object" && block[block.type]
        ? (block[block.type] as Record<string, unknown>)
        : {};
    const source =
      typeof payload.type === "string" &&
      payload[payload.type] &&
      typeof payload[payload.type] === "object"
        ? stringValue((payload[payload.type] as { url?: unknown }).url).trim()
        : "";
    if (source) {
      refs.add(source);
    }
  }
  return Array.from(refs);
}

async function notionRequest<T>(
  path: string,
  token: string,
  notionVersion: string,
  init?: RequestInit,
) {
  const requestHeaders: Record<string, string> = {};
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers).entries()) {
      requestHeaders[key] = value;
    }
  }
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": notionVersion,
      ...requestHeaders,
    },
  });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) {
    throw new Error(`Notion API request failed: ${json.message ?? response.statusText}`);
  }
  return json;
}

async function listBlockChildren(
  blockId: string,
  token: string,
  notionVersion: string,
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) {
      query.set("start_cursor", cursor);
    }
    const data = await notionRequest<{
      results: NotionBlock[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/blocks/${blockId}/children?${query.toString()}`, token, notionVersion);
    blocks.push(...data.results);
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return blocks;
}

async function collectBlocks(
  blockId: string,
  token: string,
  notionVersion: string,
): Promise<NotionBlock[]> {
  const directChildren = await listBlockChildren(blockId, token, notionVersion);
  const flattened: NotionBlock[] = [];
  for (const child of directChildren) {
    flattened.push(child);
    // Storyboard hubs often contain dozens of child pages; pulling every descendant page makes
    // intake far too slow for operator use. Keep the hub outline, but recurse only into inline
    // content blocks that expand within the same page.
    if (child.has_children && child.type !== "child_page" && child.type !== "child_database") {
      flattened.push(...(await collectBlocks(child.id, token, notionVersion)));
    }
  }
  return flattened;
}

function buildMarkdown(blocks: NotionBlock[]) {
  return blocks.flatMap(blockMarkdown).join("\n").trim();
}

export class NotionClient {
  private readonly token: string;
  private readonly notionVersion: string;

  constructor(config: NotionConfig = {}) {
    this.token = resolveNotionToken(config);
    this.notionVersion = config.version?.trim() || DEFAULT_NOTION_VERSION;
  }

  async fetchPage(input: string): Promise<NotionPageEntry> {
    const pageId = extractNotionPageId(input);
    if (!pageId) {
      throw new Error(`Invalid Notion page reference: ${input}`);
    }
    const page = await notionRequest<NotionPageResponse>(
      `/pages/${pageId}`,
      this.token,
      this.notionVersion,
    );
    const blocks = await collectBlocks(page.id, this.token, this.notionVersion);
    const markdown = buildMarkdown(blocks);
    const title =
      pickPropertyText(page.properties, ["title", "Name", "Screen"]) || "Untitled Notion page";
    const summary =
      pickPropertyText(page.properties, [
        "Summary",
        "Story Function",
        "Purpose",
        "Objective",
        "Goal",
        "What Shown",
      ]) ||
      firstNonEmptyLine(markdown) ||
      title;
    const screenCode = pickPropertyText(page.properties, ["Screen Code"]);
    const relevantScreens = Array.from(
      new Set(
        [
          screenCode ? `Screen ${screenCode}: ${title}` : title,
          pickPropertyText(page.properties, ["What Shown"]),
        ].filter(Boolean),
      ),
    );
    return {
      id: page.id,
      url: page.url,
      title,
      summary,
      markdown,
      relevantScreens,
      imageUrls: extractImageRefs(blocks, page.properties),
      updatedAt: page.last_edited_time,
    };
  }

  async fetchPages(inputs: string[]) {
    const uniqueInputs = Array.from(new Set(inputs.map((value) => value.trim()).filter(Boolean)));
    const entries = await Promise.all(uniqueInputs.map((input) => this.fetchPage(input)));
    return entries;
  }

  async searchPages(query: string, limit = 5) {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const response = await notionRequest<NotionSearchResponse>(
      "/search",
      this.token,
      this.notionVersion,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: trimmed,
          page_size: limit,
          filter: {
            property: "object",
            value: "page",
          },
        }),
      },
    );
    const pageRefs = response.results
      .filter((entry) => entry.object === "page")
      .map((entry) => entry.url?.trim() || entry.id)
      .filter(Boolean);
    return this.fetchPages(pageRefs);
  }
}
