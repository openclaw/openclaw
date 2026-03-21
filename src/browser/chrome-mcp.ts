import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../config/config.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import type { BrowserTab } from "./client.js";
import { BrowserProfileUnavailableError, BrowserTabNotFoundError } from "./errors.js";

type ChromeMcpStructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

type ChromeMcpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

type ChromeMcpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
};

type ChromeMcpSessionFactory = (profileName: string) => Promise<ChromeMcpSession>;
type ChromeMcpCallOptions = {
  timeoutMs?: number;
};

const DEFAULT_CHROME_MCP_COMMAND = "npx";
const DEFAULT_CHROME_MCP_ARGS = [
  "-y",
  "chrome-devtools-mcp@latest",
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
];

const sessions = new Map<string, ChromeMcpSession>();
const pendingSessions = new Map<string, Promise<ChromeMcpSession>>();
let sessionFactory: ChromeMcpSessionFactory | null = null;
const DEFAULT_CHROME_MCP_REQUEST_TIMEOUT_MS = 30_000;

function traceChromeMcpStage(stage: string): void {
  const stageLogPath = process.env.OPENCLAW_STAGE_LOG?.trim();
  if (!stageLogPath) {
    return;
  }
  try {
    appendFileSync(stageLogPath, `${new Date().toISOString()} ${stage}\n`);
  } catch {
    // Best-effort tracing only.
  }
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_CHROME_MCP_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function parseAttachUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:" &&
      parsed.protocol !== "ws:" &&
      parsed.protocol !== "wss:"
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

type ChromeMcpAttachTarget = {
  mode: "browserUrl" | "wsEndpoint";
  flag: "--browserUrl" | "--wsEndpoint";
  url: string;
};

function resolveAttachTarget(value: string | undefined): ChromeMcpAttachTarget | null {
  const parsed = parseAttachUrl(value);
  if (!parsed) {
    return null;
  }
  const protocol = new URL(parsed).protocol;
  if (protocol === "ws:" || protocol === "wss:") {
    return {
      mode: "wsEndpoint",
      flag: "--wsEndpoint",
      url: parsed,
    };
  }
  return {
    mode: "browserUrl",
    flag: "--browserUrl",
    url: parsed,
  };
}

function resolveConfiguredAttachTarget(profileName: string): ChromeMcpAttachTarget | null {
  const envWs = resolveAttachTarget(process.env.OPENCLAW_CHROME_MCP_WS_ENDPOINT);
  if (envWs) {
    return envWs;
  }
  const envBrowser = resolveAttachTarget(process.env.OPENCLAW_CHROME_MCP_BROWSER_URL);
  if (envBrowser) {
    return envBrowser;
  }
  try {
    const cfg = loadConfig();
    const profileTarget = resolveAttachTarget(cfg.browser?.profiles?.[profileName]?.cdpUrl);
    if (profileTarget) {
      return profileTarget;
    }
    return resolveAttachTarget(cfg.browser?.cdpUrl);
  } catch {
    return null;
  }
}

function resolveChromeMcpArgs(profileName: string): string[] {
  const attachTarget = resolveConfiguredAttachTarget(profileName);
  if (attachTarget) {
    traceChromeMcpStage(
      `chrome-mcp-attach-mode profile=${profileName} mode=${attachTarget.mode} url=${attachTarget.url}`,
    );
    return [...DEFAULT_CHROME_MCP_ARGS, attachTarget.flag, attachTarget.url];
  }
  traceChromeMcpStage(`chrome-mcp-attach-mode profile=${profileName} mode=autoConnect`);
  return [...DEFAULT_CHROME_MCP_ARGS, "--autoConnect"];
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPages(value: unknown): ChromeMcpStructuredPage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChromeMcpStructuredPage[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "number") {
      continue;
    }
    out.push({
      id: record.id,
      url: typeof record.url === "string" ? record.url : undefined,
      selected: record.selected === true,
    });
  }
  return out;
}

function parsePageId(targetId: string): number {
  const parsed = Number.parseInt(targetId.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new BrowserTabNotFoundError();
  }
  return parsed;
}

function toBrowserTabs(pages: ChromeMcpStructuredPage[]): BrowserTab[] {
  return pages.map((page) => ({
    targetId: String(page.id),
    title: "",
    url: page.url ?? "",
    type: "page",
  }));
}

function extractStructuredContent(result: ChromeMcpToolResult): Record<string, unknown> {
  return asRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: ChromeMcpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
}

function extractTextPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const pages: ChromeMcpStructuredPage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
      if (!match) {
        continue;
      }
      pages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        url: match[2]?.trim() || undefined,
        selected: Boolean(match[3]),
      });
    }
  }
  return pages;
}

function extractStructuredPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const structured = asPages(extractStructuredContent(result).pages);
  return structured.length > 0 ? structured : extractTextPages(result);
}

function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const structured = extractStructuredContent(result);
  const snapshot = asRecord(structured.snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot as unknown as ChromeMcpSnapshotNode;
}

function extractJsonBlock(text: string): unknown {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = match?.[1]?.trim() || text.trim();
  return raw ? JSON.parse(raw) : null;
}

function extractMessageText(result: ChromeMcpToolResult): string {
  const message = extractStructuredContent(result).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  const blocks = extractTextContent(result);
  return blocks.find((block) => block.trim()) ?? "";
}

function extractToolErrorMessage(result: ChromeMcpToolResult, name: string): string {
  const message = extractMessageText(result).trim();
  return message || `Chrome MCP tool "${name}" failed.`;
}

function extractJsonMessage(result: ChromeMcpToolResult): unknown {
  const candidates = [extractMessageText(result), ...extractTextContent(result)].filter((text) =>
    text.trim(),
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return extractJsonBlock(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

async function createRealSession(profileName: string): Promise<ChromeMcpSession> {
  const args = resolveChromeMcpArgs(profileName);
  const transport = new StdioClientTransport({
    command: DEFAULT_CHROME_MCP_COMMAND,
    args,
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "openclaw-browser",
      version: "0.0.0",
    },
    {},
  );

  const ready = (async () => {
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "list_pages")) {
        throw new Error("Chrome MCP server did not expose the expected navigation tools.");
      }
    } catch (err) {
      await client.close().catch(() => {});
      throw new BrowserProfileUnavailableError(
        `Chrome MCP existing-session attach failed for profile "${profileName}". ` +
          `Make sure Chrome (v144+) is running. ` +
          `Details: ${String(err)}`,
      );
    }
  })();

  return {
    client,
    transport,
    ready,
  };
}

async function getSession(
  profileName: string,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpSession> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  traceChromeMcpStage(`chrome-mcp-session-get-start profile=${profileName} timeoutMs=${timeoutMs}`);
  let session = sessions.get(profileName);
  if (session && session.transport.pid === null) {
    sessions.delete(profileName);
    session = undefined;
  }
  if (!session) {
    let pending = pendingSessions.get(profileName);
    if (!pending) {
      traceChromeMcpStage(`chrome-mcp-session-create-start profile=${profileName}`);
      pending = (async () => {
        const created = await (sessionFactory ?? createRealSession)(profileName);
        sessions.set(profileName, created);
        traceChromeMcpStage(`chrome-mcp-session-create-done profile=${profileName}`);
        return created;
      })();
      pendingSessions.set(profileName, pending);
    }
    try {
      session = await pending;
    } finally {
      if (pendingSessions.get(profileName) === pending) {
        pendingSessions.delete(profileName);
      }
    }
  }
  try {
    await withTimeout(session.ready, timeoutMs, () => {
      return new BrowserProfileUnavailableError(
        `Chrome MCP attach timed out for profile "${profileName}" after ${timeoutMs}ms.`,
      );
    });
    traceChromeMcpStage(`chrome-mcp-session-ready profile=${profileName}`);
    return session;
  } catch (err) {
    const current = sessions.get(profileName);
    if (current?.transport === session.transport) {
      sessions.delete(profileName);
    }
    await session.client.close().catch(() => {});
    throw err;
  }
}

async function callTool(
  profileName: string,
  name: string,
  args: Record<string, unknown> = {},
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpToolResult> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  traceChromeMcpStage(
    `chrome-mcp-tool-start profile=${profileName} tool=${name} timeoutMs=${timeoutMs}`,
  );
  const session = await getSession(profileName, { timeoutMs });
  let result: ChromeMcpToolResult;
  try {
    result = (await session.client.callTool(
      {
        name,
        arguments: args,
      },
      undefined,
      {
        timeout: timeoutMs,
      },
    )) as ChromeMcpToolResult;
  } catch (err) {
    // Transport/connection error — tear down session so it reconnects on next call
    sessions.delete(profileName);
    await session.client.close().catch(() => {});
    throw err;
  }
  // Tool-level errors (element not found, script error, etc.) don't indicate a
  // broken connection — don't tear down the session for these.
  if (result.isError) {
    throw new Error(extractToolErrorMessage(result, name));
  }
  traceChromeMcpStage(`chrome-mcp-tool-done profile=${profileName} tool=${name}`);
  return result;
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-mcp-"));
  const filePath = path.join(dir, randomUUID());
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findPageById(profileName: string, pageId: number): Promise<ChromeMcpStructuredPage> {
  const pages = await listChromeMcpPages(profileName);
  const page = pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

export async function ensureChromeMcpAvailable(
  profileName: string,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  await getSession(profileName, options);
}

export function getChromeMcpPid(profileName: string): number | null {
  return sessions.get(profileName)?.transport.pid ?? null;
}

export async function closeChromeMcpSession(profileName: string): Promise<boolean> {
  pendingSessions.delete(profileName);
  const session = sessions.get(profileName);
  if (!session) {
    return false;
  }
  sessions.delete(profileName);
  await session.client.close().catch(() => {});
  return true;
}

export async function stopAllChromeMcpSessions(): Promise<void> {
  const names = [...sessions.keys()];
  for (const name of names) {
    await closeChromeMcpSession(name).catch(() => {});
  }
}

export async function listChromeMcpPages(
  profileName: string,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpStructuredPage[]> {
  const result = await callTool(profileName, "list_pages", {}, options);
  return extractStructuredPages(result);
}

export async function listChromeMcpTabs(
  profileName: string,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab[]> {
  return toBrowserTabs(await listChromeMcpPages(profileName, options));
}

export async function openChromeMcpTab(
  profileName: string,
  url: string,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab> {
  const result = await callTool(
    profileName,
    "new_page",
    {
      url,
      ...(typeof options.timeoutMs === "number" ? { timeout: options.timeoutMs } : {}),
    },
    options,
  );
  const pages = extractStructuredPages(result);
  const chosen = pages.find((page) => page.selected) ?? pages.at(-1);
  if (!chosen) {
    throw new Error("Chrome MCP did not return the created page.");
  }
  return {
    targetId: String(chosen.id),
    title: "",
    url: chosen.url ?? url,
    type: "page",
  };
}

export async function focusChromeMcpTab(profileName: string, targetId: string): Promise<void> {
  await callTool(profileName, "select_page", {
    pageId: parsePageId(targetId),
    bringToFront: true,
  });
}

export async function closeChromeMcpTab(profileName: string, targetId: string): Promise<void> {
  await callTool(profileName, "close_page", { pageId: parsePageId(targetId) });
}

export async function navigateChromeMcpPage(params: {
  profileName: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  await callTool(params.profileName, "navigate_page", {
    pageId: parsePageId(params.targetId),
    type: "url",
    url: params.url,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
  const page = await findPageById(params.profileName, parsePageId(params.targetId));
  return { url: page.url ?? params.url };
}

export async function takeChromeMcpSnapshot(params: {
  profileName: string;
  targetId: string;
}): Promise<ChromeMcpSnapshotNode> {
  const result = await callTool(params.profileName, "take_snapshot", {
    pageId: parsePageId(params.targetId),
  });
  return extractSnapshot(result);
}

export async function takeChromeMcpScreenshot(params: {
  profileName: string;
  targetId: string;
  uid?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
}): Promise<Buffer> {
  return await withTempFile(async (filePath) => {
    await callTool(params.profileName, "take_screenshot", {
      pageId: parsePageId(params.targetId),
      filePath,
      format: params.format ?? "png",
      ...(params.uid ? { uid: params.uid } : {}),
      ...(params.fullPage ? { fullPage: true } : {}),
    });
    return await fs.readFile(filePath);
  });
}

export async function clickChromeMcpElement(params: {
  profileName: string;
  targetId: string;
  uid: string;
  doubleClick?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutOptions =
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined;
  await callTool(
    params.profileName,
    "click",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
      ...(params.doubleClick ? { dblClick: true } : {}),
      ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
    },
    timeoutOptions,
  );
}

export async function fillChromeMcpElement(params: {
  profileName: string;
  targetId: string;
  uid: string;
  value: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutOptions =
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined;
  await callTool(
    params.profileName,
    "fill",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
      value: params.value,
      ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
    },
    timeoutOptions,
  );
}

export async function fillChromeMcpForm(params: {
  profileName: string;
  targetId: string;
  elements: Array<{ uid: string; value: string }>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutOptions =
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined;
  await callTool(
    params.profileName,
    "fill_form",
    {
      pageId: parsePageId(params.targetId),
      elements: params.elements,
      ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
    },
    timeoutOptions,
  );
}

export async function hoverChromeMcpElement(params: {
  profileName: string;
  targetId: string;
  uid: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutOptions =
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined;
  await callTool(
    params.profileName,
    "hover",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
      ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
    },
    timeoutOptions,
  );
}

export async function dragChromeMcpElement(params: {
  profileName: string;
  targetId: string;
  fromUid: string;
  toUid: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutOptions =
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined;
  await callTool(
    params.profileName,
    "drag",
    {
      pageId: parsePageId(params.targetId),
      from_uid: params.fromUid,
      to_uid: params.toUid,
      ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
    },
    timeoutOptions,
  );
}

export async function uploadChromeMcpFile(params: {
  profileName: string;
  targetId: string;
  uid: string;
  filePath: string;
}): Promise<void> {
  await callTool(params.profileName, "upload_file", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    filePath: params.filePath,
  });
}

export async function pressChromeMcpKey(params: {
  profileName: string;
  targetId: string;
  key: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutOptions =
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined;
  await callTool(
    params.profileName,
    "press_key",
    {
      pageId: parsePageId(params.targetId),
      key: params.key,
      ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
    },
    timeoutOptions,
  );
}

export async function resizeChromeMcpPage(params: {
  profileName: string;
  targetId: string;
  width: number;
  height: number;
}): Promise<void> {
  await callTool(params.profileName, "resize_page", {
    pageId: parsePageId(params.targetId),
    width: params.width,
    height: params.height,
  });
}

export async function handleChromeMcpDialog(params: {
  profileName: string;
  targetId: string;
  action: "accept" | "dismiss";
  promptText?: string;
}): Promise<void> {
  await callTool(params.profileName, "handle_dialog", {
    pageId: parsePageId(params.targetId),
    action: params.action,
    ...(params.promptText ? { promptText: params.promptText } : {}),
  });
}

export async function evaluateChromeMcpScript(params: {
  profileName: string;
  targetId: string;
  fn: string;
  args?: string[];
}): Promise<unknown> {
  const result = await callTool(params.profileName, "evaluate_script", {
    pageId: parsePageId(params.targetId),
    function: params.fn,
    ...(params.args?.length ? { args: params.args } : {}),
  });
  return extractJsonMessage(result);
}

export async function waitForChromeMcpText(params: {
  profileName: string;
  targetId: string;
  text: string[];
  timeoutMs?: number;
}): Promise<void> {
  await callTool(params.profileName, "wait_for", {
    pageId: parsePageId(params.targetId),
    text: params.text,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
}

export function setChromeMcpSessionFactoryForTest(factory: ChromeMcpSessionFactory | null): void {
  sessionFactory = factory;
}

export async function resetChromeMcpSessionsForTest(): Promise<void> {
  sessionFactory = null;
  pendingSessions.clear();
  await stopAllChromeMcpSessions();
}
