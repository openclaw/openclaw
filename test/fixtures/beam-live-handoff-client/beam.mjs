#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import {
  renderSession,
  resolveClaudeSession,
  resolveCodexSession,
  sanitizeVisibleText,
} from "./beam-session.js";
import { openHandoffs, releaseSource, transferredReceipt, useDestination } from "./beam-handoff.js";

const MAX_UPLOAD_BYTES = 52 * 1024;
const MAX_UPLOAD_ITEMS = 200;
const MAX_UPLOAD_ITEM_CHARS = 6_000;
const DEFAULT_TIMEOUT_MS = 15_000;

function usage() {
  console.log(`Usage:
  beam publish --endpoint URL [--session FILE | --session-id ID | --thread-id ID] [--title TEXT] [--complete] [--dry-run]
  beam hook --endpoint URL [--quiet] [--dry-run]
  beam handoff --endpoint URL [--session FILE | --session-id ID | --thread-id ID]
  beam read --endpoint URL --beam-id ID --profile-dir DIR
  beam continue --endpoint URL --beam-id ID --profile-dir DIR --message TEXT [--request-id ID]

Environment:
  BEAM_ENDPOINT       Default receiver URL
  BEAM_ACCESS_TOKEN   Cloudflare Access application token (sent as cf-access-token)
  BEAM_AUTH_TOKEN     Gateway bearer token fallback (sent as Authorization: Bearer)

Guests use their own Cloudflare Access sign-in or BEAM_ACCESS_TOKEN, never a shared Gateway token.
The hook command reads Claude Code or Codex hook JSON from stdin. Raw transcripts never leave the machine.`);
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      result._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = value;
    index++;
  }
  return result;
}

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hook input must be a JSON object");
  }
  return value;
}

function exactFile(candidate, label, disclosePath) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  try {
    const file = fs.realpathSync(candidate);
    if (!fs.statSync(file).isFile()) throw new Error();
    return file;
  } catch {
    throw new Error(disclosePath ? `${label} file does not exist: ${candidate}` : `${label} file does not exist`);
  }
}

function tryResolve(resolve, identity) {
  try {
    return resolve(identity);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("no exact ")) return null;
    throw error;
  }
}

function resolveHookSession(hook) {
  if (hook.thread_id) return resolveCodexSession(hook.thread_id);
  if (!hook.session_id) return null;
  const candidates = [
    tryResolve(resolveClaudeSession, hook.session_id),
    tryResolve(resolveCodexSession, hook.session_id),
  ].filter(Boolean);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error("hook session id matches both Claude and Codex transcripts");
  }
  throw new Error("no exact transcript was found for the hook session id");
}

function resolveSession(options, hook) {
  if (options.session) {
    return {
      file: exactFile(options.session, "session", true),
      source: undefined,
      identity: undefined,
    };
  }
  const hookFile = hook.transcript_path || hook.agent_transcript_path;
  if (hookFile) {
    return {
      file: exactFile(hookFile, "hook transcript", false),
      source: undefined,
      identity: undefined,
    };
  }
  const explicitThreadId = options["thread-id"] || options.threadId;
  if (explicitThreadId) return resolveCodexSession(explicitThreadId);
  const explicitSessionId = options["session-id"] || options.sessionId;
  if (explicitSessionId) return resolveClaudeSession(explicitSessionId);
  const hookSession = resolveHookSession(hook);
  if (hookSession) return hookSession;
  if (process.env.CODEX_THREAD_ID) return resolveCodexSession(process.env.CODEX_THREAD_ID);
  if (process.env.CLAUDE_SESSION_ID) return resolveClaudeSession(process.env.CLAUDE_SESSION_ID);
  throw new Error("could not identify the current session; pass --session, --session-id, or --thread-id");
}

function normalizeItems(rendered, hook, options) {
  const items = rendered.items.map((item) => ({ ...item }));
  const entryMaxChars = parseEntryMaxChars(options);
  const lastAssistant =
    typeof hook.last_assistant_message === "string" && hook.last_assistant_message.trim()
      ? sanitizeVisibleText(hook.last_assistant_message, { maxChars: entryMaxChars })
      : "";
  const previousAssistant = items.findLast((item) => item.type === "agentMessage")?.text;
  if (lastAssistant && previousAssistant !== lastAssistant) {
    items.push({ type: "agentMessage", text: lastAssistant });
  }
  return items;
}

function positiveInteger(value, fallback, label, minimum = 1) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return Math.floor(parsed);
}

function parseEntryMaxChars(options) {
  const value = positiveInteger(
    options["entry-max-chars"],
    MAX_UPLOAD_ITEM_CHARS,
    "--entry-max-chars",
  );
  if (value > MAX_UPLOAD_ITEM_CHARS) {
    throw new Error(`--entry-max-chars must be at most ${MAX_UPLOAD_ITEM_CHARS}`);
  }
  return value;
}

function titleFromItems(items) {
  const firstUser = items.find((item) => item.type === "userMessage")?.text || "Beamed coding session";
  return firstUser.split(/\r?\n/, 1)[0].trim().slice(0, 160) || "Beamed coding session";
}

function explicitTitle(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const sanitized = sanitizeVisibleText(value, { maxChars: 160 });
  return sanitized ? sanitized.split(/\r?\n/, 1)[0] : null;
}

function stableBeamId(source, identity) {
  return createHash("sha256").update(`${source}:${identity}`).digest("hex").slice(0, 32);
}

function fitPayload(payload, maxChars, explicitTitle) {
  const next = structuredClone(payload);
  let totalChars = next.items.reduce((sum, item) => sum + item.text.length, 0);
  while (totalChars > maxChars && next.items.length > 1) {
    const visibleCount = next.items.filter((item) => item.type !== "other").length;
    const removableIndex =
      visibleCount <= 1 ? next.items.findIndex((item) => item.type === "other") : 0;
    const index = removableIndex >= 0 ? removableIndex : 0;
    totalChars -= next.items.splice(index, 1)[0].text.length;
    next.truncated = true;
  }
  if (totalChars > maxChars && next.items[0]) {
    const marker = "\n...[truncated for Beam]";
    next.items[0].text =
      maxChars <= marker.length
        ? marker.slice(0, maxChars)
        : `${next.items[0].text.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
    next.truncated = true;
  }
  while (next.items.length > MAX_UPLOAD_ITEMS) {
    next.items.shift();
    next.truncated = true;
  }
  const refreshDerivedTitle = () => {
    if (!explicitTitle) next.title = titleFromItems(next.items);
  };
  refreshDerivedTitle();
  while (Buffer.byteLength(JSON.stringify(next)) > MAX_UPLOAD_BYTES && next.items.length > 1) {
    const visibleCount = next.items.filter((item) => item.type !== "other").length;
    const removableIndex =
      visibleCount <= 1 ? next.items.findIndex((item) => item.type === "other") : 0;
    const index = removableIndex >= 0 ? removableIndex : 0;
    next.items.splice(index, 1);
    next.truncated = true;
    refreshDerivedTitle();
  }
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_UPLOAD_BYTES) {
    const only = next.items[0];
    if (!only) throw new Error("sanitized session payload is empty");
    const excess = Buffer.byteLength(JSON.stringify(next)) - MAX_UPLOAD_BYTES;
    only.text = `${only.text.slice(0, Math.max(0, only.text.length - excess - 128)).trimEnd()}\n...[truncated for Beam]`;
    next.truncated = true;
    refreshDerivedTitle();
  }
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_UPLOAD_BYTES) {
    throw new Error("sanitized session payload exceeds the Beam upload limit");
  }
  return next;
}

function buildPayload(options, hook) {
  const session = resolveSession(options, hook);
  const rendered = renderSession(session.file, {
    source: session.source,
    maxChars: parseEntryMaxChars(options),
  });
  const items = normalizeItems(rendered, hook, options);
  if (!items.length) throw new Error("the sanitized session contains no shareable messages");

  const source = rendered.source;
  const identity =
    rendered.identity ||
    session.identity ||
    options["thread-id"] ||
    options["session-id"] ||
    hook.thread_id ||
    hook.session_id ||
    session.file;
  const hookEvent = typeof hook.hook_event_name === "string" ? hook.hook_event_name : undefined;
  const sanitizedExplicitTitle = explicitTitle(options.title);
  return fitPayload(
    {
      version: 1,
      beamId: stableBeamId(source, identity),
      source,
      title: sanitizedExplicitTitle || titleFromItems(items),
      updatedAt: new Date().toISOString(),
      completed: Boolean(options.complete || hookEvent === "SessionEnd"),
      ...(rendered.truncated ? { truncated: true } : {}),
      ...(hookEvent ? { hookEvent } : {}),
      ...(rendered.sourceModel ? { sourceModel: rendered.sourceModel } : {}),
      items,
    },
    positiveInteger(options["max-chars"], 48_000, "--max-chars", 32),
    Boolean(sanitizedExplicitTitle),
  );
}

function isLoopbackUrl(url) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function expectedControlUiBasePath(endpoint) {
  const suffix = "/api/v1/beam/sessions";
  return endpoint.pathname.endsWith(suffix)
    ? endpoint.pathname.slice(0, -suffix.length)
    : "";
}

function isSafeReceiverUrl(resultUrl, endpoint) {
  return (
    ["http:", "https:"].includes(resultUrl.protocol) &&
    resultUrl.origin === endpoint.origin &&
    !resultUrl.hash &&
    !resultUrl.username &&
    !resultUrl.password
  );
}

function isPrettyBeamUrl(resultUrl, endpoint, beamId) {
  const pathPrefix = `${expectedControlUiBasePath(endpoint)}/beam/`;
  const returnedPath = resultUrl.pathname.startsWith(pathPrefix)
    ? resultUrl.pathname.slice(pathPrefix.length)
    : "";
  const match = /^(?:([a-z0-9]+(?:-[a-z0-9]+)*)-)?([0-9a-f]{12,32})$/u.exec(returnedPath);
  return (
    /^[0-9a-f]{32}$/u.test(beamId) &&
    match !== null &&
    (match[1]?.length ?? 0) <= 48 &&
    beamId.startsWith(match[2]) &&
    resultUrl.searchParams.size === 0
  );
}

function isCanonicalCatalogUrl(resultUrl, endpoint, beamId) {
  const pathPrefix = `${expectedControlUiBasePath(endpoint)}/chat/`;
  const agentId = resultUrl.pathname.startsWith(pathPrefix)
    ? resultUrl.pathname.slice(pathPrefix.length)
    : "";
  const entries = [...resultUrl.searchParams.entries()];
  return (
    /^[a-z0-9_][a-z0-9_-]{0,63}$/u.test(agentId) &&
    entries.length === 3 &&
    resultUrl.searchParams.getAll("catalog").length === 1 &&
    resultUrl.searchParams.get("catalog") === "beam" &&
    resultUrl.searchParams.getAll("host").length === 1 &&
    resultUrl.searchParams.get("host") === "gateway" &&
    resultUrl.searchParams.getAll("thread").length === 1 &&
    resultUrl.searchParams.get("thread") === beamId
  );
}

function endpointUrl(options) {
  const raw = options.endpoint || process.env.BEAM_ENDPOINT;
  if (!raw) throw new Error("--endpoint or BEAM_ENDPOINT is required");
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackUrl(url))) {
    throw new Error("Beam endpoints must use HTTPS unless they are loopback-local");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Beam endpoint must not contain credentials, query parameters or a fragment");
  return url;
}

function cloudflaredToken(origin) {
  try {
    const cached = execFileSync("cloudflared", ["access", "token", `--app=${origin}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (cached) return cached;
  } catch {
    // Continue into the interactive browser login below.
  }
  execFileSync("cloudflared", ["access", "login", "--quiet", origin], {
    stdio: ["inherit", "ignore", "inherit"],
  });
  return execFileSync("cloudflared", ["access", "token", `--app=${origin}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function authContext(url, allowInteractiveLogin) {
  const accessToken = process.env.BEAM_ACCESS_TOKEN?.trim();
  if (accessToken) {
    return { headers: { "cf-access-token": accessToken }, secrets: [accessToken] };
  }
  const bearer = process.env.BEAM_AUTH_TOKEN?.trim();
  if (bearer) {
    return { headers: { authorization: `Bearer ${bearer}` }, secrets: [bearer] };
  }
  if (isLoopbackUrl(url)) return { headers: {}, secrets: [] };
  if (!allowInteractiveLogin) {
    throw new Error("no Beam credentials configured for non-interactive hook publishing");
  }
  const token = cloudflaredToken(url.origin);
  if (!token) throw new Error("Cloudflare Access login did not return a token");
  return { headers: { "cf-access-token": token }, secrets: [token] };
}

function printableReceiverText(value) {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  return String(value)
    .replace(ansiEscape, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u200B-\u200D\u2060\uFEFF]/g, " ")
    .trim();
}

function safeReceiverMessage(value, fallback, secrets) {
  if (typeof value !== "string" || secrets.length > 0) return fallback;
  return printableReceiverText(value).slice(0, 240) || fallback;
}

async function publish(payload, options) {
  const url = endpointUrl(options);
  if (options["dry-run"] || options.dryRun) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return { ok: true, beamId: payload.beamId, dryRun: true };
  }
  const auth = authContext(url, options.hookMode !== true);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "openclaw-agent-skills-beam/1",
      ...auth.headers,
    },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(Number(options.timeout || DEFAULT_TIMEOUT_MS)),
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Beam receiver returned invalid JSON (HTTP ${response.status})`);
  }
  if ((!response.ok || result?.ok === false) && !(response.status === 409 && transferredReceipt(result))) {
    const message = safeReceiverMessage(result?.error, `HTTP ${response.status}`, auth.secrets);
    throw new Error(`Beam upload failed: ${message}`);
  }
  if (Object.hasOwn(result, "canView") && typeof result.canView !== "boolean") {
    throw new Error("Beam receiver returned an invalid canView receipt field");
  }
  if (Object.hasOwn(result, "handoff") && (!transferredReceipt(result) || result.beamId !== payload.beamId || typeof result.url !== "string")) {
    throw new Error("Beam receiver returned an invalid handoff receipt");
  }
  if (typeof result.url === "string") {
    const printableUrl = printableReceiverText(result.url);
    if (printableUrl !== result.url) {
      throw new Error("Beam receiver returned an unsafe session URL");
    }
    const resultUrl = new URL(printableUrl, url);
    if (
      !isSafeReceiverUrl(resultUrl, url) ||
      (!isPrettyBeamUrl(resultUrl, url, payload.beamId) &&
        !isCanonicalCatalogUrl(resultUrl, url, payload.beamId))
    ) {
      throw new Error("Beam receiver returned an unsafe session URL");
    }
    result.url = resultUrl.toString();
  }
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (!command || command === "--help" || command === "-h" || options.help) {
    usage();
    return;
  }
  if (!["publish", "hook", "handoff", "read", "continue"].includes(command)) {
    usage();
    process.exitCode = 2;
    return;
  }
  const hook = command === "hook" ? readStdinJson() : {};
  options.hookMode = command === "hook";
  const event = hook.hook_event_name;
  const isSubagentHook = event === "SubagentStop" || typeof hook.agent_id === "string";
  if (
    command === "hook" &&
    (isSubagentHook || (event && !["Stop", "SessionEnd"].includes(event)))
  ) {
    return;
  }
  const payload = ["handoff", "read", "continue"].includes(command) && options["beam-id"]
    ? { beamId: options["beam-id"] }
    : buildPayload(options, hook);
  if (!/^[a-f0-9]{32}$/.test(payload.beamId)) throw new Error("--beam-id must be a 32-character lowercase hex ID");
  if (options["dry-run"]) {
    if (!["publish", "hook"].includes(command)) throw new Error("--dry-run is only supported for snapshot publishing; no ownership change was made");
    await publish(payload, options);
    return;
  }
  const endpoint = endpointUrl(options).href;
  let state = await openHandoffs(options, !["publish", "hook"].includes(command));
  let result;
  try {
    if (command === "read" || command === "continue") {
      if (command === "continue" && (typeof options.message !== "string" || !options.message.trim() || options.message.length > 32_000)) throw new Error("--message must contain 1-32000 characters");
      if (command === "continue") {
        options["request-id"] ||= randomUUID();
        if (typeof options["request-id"] !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(options["request-id"])) throw new Error("--request-id must contain 1-128 letters, digits, underscores or hyphens");
        console.error(`Beam request ID: ${options["request-id"]}; reuse --request-id after an uncertain send.`);
      }
      result = useDestination(state, endpoint, payload.beamId, options, command === "continue" ? options.message : undefined);
      console.log(JSON.stringify(result));
      return;
    }
    if (command === "handoff") {
      result = await releaseSource(state, endpoint, payload, (frozen) => publish(frozen, options));
    } else {
      const retired = state?.get(endpoint, payload.beamId);
      if (retired) {
        if (!retired.receipt) throw new Error("Source retired with handoff pending. Retry handoff at this endpoint; do not publish or continue the local transcript.");
        result = JSON.parse(retired.receipt);
      } else {
        result = await publish(payload, options);
        if (transferredReceipt(result)) {
          state ??= await openHandoffs(options);
          state.begin(endpoint, payload);
          state.acknowledge(endpoint, payload.beamId, result);
        }
      }
    }
  } finally {
    state?.close();
  }
  if (options.quiet && transferredReceipt(result)) {
    console.error(`Source Beam is retired. Use beam read/continue --beam-id ${payload.beamId} at this endpoint with your normal remote profile.`);
  }
  if (!options.quiet) {
    const target = result.url || payload.beamId;
    if (transferredReceipt(result)) {
      console.log(`Conversation handed to Team: ${target}`);
      console.log(`Source Beam is retired. Use beam read/continue --beam-id ${payload.beamId} with your own normal remote profile.`);
    } else if (result.canView === false) {
      console.log(`Beam upload succeeded: ${target}`);
      console.log("This link is for authorized Team operators; upload-only access does not let you open it.");
    } else {
      console.log(`Beamed session: ${target}`);
    }
    if (!transferredReceipt(result)) {
      console.log("Snapshot is read-only. To continue in Team, its authenticated original publisher must run beam handoff with the same endpoint and source transcript selector.");
    }
  }
}

function safeLocalError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    return sanitizeVisibleText(raw, { maxChars: 240 }) || "Beam failed safely";
  } catch {
    return "Beam failed safely";
  }
}

try {
  await main();
} catch (error) {
  console.error(safeLocalError(error));
  process.exit(1);
}
