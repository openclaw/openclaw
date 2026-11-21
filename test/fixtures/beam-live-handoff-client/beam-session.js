import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const MAX_DISCOVERY_FILES = 20_000;
const DEFAULT_ENTRY_MAX_CHARS = 6_000;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeIdentity(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(normalized)) {
    throw new Error(`${label} is not a valid session identifier`);
  }
  return normalized;
}

function uniqueRealFiles(files) {
  const seen = new Set();
  const results = [];
  for (const file of files) {
    try {
      const real = fs.realpathSync(file);
      if (seen.has(real) || !fs.statSync(real).isFile()) continue;
      seen.add(real);
      results.push(real);
    } catch {
      // Ignore files removed during discovery.
    }
  }
  return results;
}

function walkJsonl(root, match, state, out) {
  if (state.exhausted || !root || !fs.existsSync(root)) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.exhausted) break;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(candidate, match, state, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    if (state.files >= state.maxFiles) {
      state.exhausted = true;
      break;
    }
    state.files++;
    if (match(entry.name, candidate)) out.push(candidate);
  }
}

function claudeProjectsRoot(env) {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir ? path.resolve(configDir) : path.join(os.homedir(), ".claude"), "projects");
}

function codexRoots(env) {
  const codexHome = path.resolve(env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"));
  return [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
}

function readPrefix(file, maxBytes = TRANSCRIPT_HEAD_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const size = Math.min(stat.size, maxBytes);
    return readRegion(fd, 0, size);
  } finally {
    fs.closeSync(fd);
  }
}

function codexMetadataId(file) {
  for (const line of readPrefix(file).split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === "session_meta" && typeof row?.payload?.id === "string") {
        return row.payload.id;
      }
    } catch {
      // Continue until the bounded prefix is exhausted.
    }
  }
  return null;
}

function requireUnique(files, description) {
  const candidates = uniqueRealFiles(files);
  if (candidates.length === 0) throw new Error(`no exact ${description} transcript was found`);
  if (candidates.length > 1) throw new Error(`multiple exact ${description} transcripts were found`);
  return candidates[0];
}

export function resolveClaudeSession(sessionId, env = process.env, options = {}) {
  const identity = safeIdentity(sessionId, "Claude session id");
  const matches = [];
  const state = {
    files: 0,
    exhausted: false,
    maxFiles: options.maxFiles ?? MAX_DISCOVERY_FILES,
  };
  walkJsonl(
    claudeProjectsRoot(env),
    (name) => name === `${identity}.jsonl`,
    state,
    matches,
  );
  if (state.exhausted) throw new Error("Claude session discovery exceeded its file limit");
  return { file: requireUnique(matches, "Claude session"), source: "claude", identity };
}

export function resolveCodexSession(threadId, env = process.env, options = {}) {
  const identity = safeIdentity(threadId, "Codex thread id");
  const matches = [];
  const state = {
    files: 0,
    exhausted: false,
    maxFiles: options.maxFiles ?? MAX_DISCOVERY_FILES,
  };
  for (const root of codexRoots(env)) {
    walkJsonl(root, (name) => name.includes(identity), state, matches);
  }
  if (state.exhausted) throw new Error("Codex session discovery exceeded its file limit");
  const verified = uniqueRealFiles(matches).filter((file) => codexMetadataId(file) === identity);
  return { file: requireUnique(verified, "Codex thread"), source: "codex", identity };
}

function readRegion(fd, start, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
    if (read === 0) {
      throw new Error("session file ended before the expected read completed; retry publication");
    }
    offset += read;
  }
  return buffer.toString("utf8");
}

function completeHead(text) {
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
}

function completeTail(text) {
  const firstNewline = text.indexOf("\n");
  return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
}

function readBoundedJsonl(file) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size <= MAX_TRANSCRIPT_BYTES) {
      return { text: readRegion(fd, 0, stat.size), truncated: false };
    }
    const headLength = Math.min(TRANSCRIPT_HEAD_BYTES, stat.size);
    const tailLength = MAX_TRANSCRIPT_BYTES - headLength;
    const head = completeHead(readRegion(fd, 0, headLength));
    const tail = completeTail(readRegion(fd, stat.size - tailLength, tailLength));
    return { text: `${head}${tail}`, truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

function parseRows(file) {
  const bounded = readBoundedJsonl(file);
  const rows = [];
  for (const line of bounded.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A corrupt or partial record is ignored; other records remain usable.
    }
  }
  return { rows, truncated: bounded.truncated };
}

function textBlock(block) {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return "";
  const type = String(block.type || "").toLowerCase();
  if (["thinking", "reasoning", "tool_use", "tool_result", "image", "image_url"].includes(type)) {
    return "";
  }
  if (["text", "input_text", "output_text"].includes(type) && typeof block.text === "string") {
    return block.text;
  }
  if (typeof block.text === "string" && !type) return block.text;
  return "";
}

function visibleText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textBlock).filter(Boolean).join("\n");
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.message === "string") return content.message;
    if (typeof content.content === "string") return content.content;
    if (Array.isArray(content.content)) return visibleText(content.content);
  }
  return "";
}

function stripInternalWrappers(input) {
  return String(input || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "");
}

function isSetupText(text) {
  const trimmed = text.trim();
  return (
    /^<INSTRUCTIONS>/i.test(trimmed) ||
    /^Knowledge cutoff:/i.test(trimmed) ||
    /^You are (?:Codex|Claude Code|an AI assistant)\b/i.test(trimmed)
  );
}

const SECRET_FIELD =
  "(?:[a-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|dsn)[a-z0-9_-]*|pass|passcode|passphrase|pass[_-]phrase|(?:db|ssh|mfa|otp|auth|login|sudo|proxy|app|service|account|user|admin)[_-](?:pass|passcode|passphrase|pass[_-]phrase)(?:[_-](?:b64|file|path|value|secret))?|database[_-]?url|redis[_-]?url|sid|session[_-]?id|phpsessid|jsessionid|csrf[_-]?token|xsrf[_-]?token|authorization|proxy-authorization|cookie|set-cookie)";

function replaceTracked(text, pattern, replacement, stats) {
  const next = text.replace(pattern, replacement);
  if (next !== text) stats.redactions++;
  return next;
}

function decodePercentRuns(value) {
  let current = String(value).replaceAll("+", " ");
  for (let depth = 0; depth < 8; depth++) {
    const malformed =
      depth === 0
        ? /%(?![0-9A-Fa-f]{2})/.test(current)
        : /%(?=[A-Za-z0-9]{2})/.test(current);
    if (malformed) return { value: current, complete: false };
    if (!/%[0-9A-Fa-f]{2}/.test(current)) {
      return { value: current, complete: true };
    }
    let invalid = false;
    const decoded = current.replace(/(?:%[0-9A-Fa-f]{2})+/g, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        invalid = true;
        return encoded;
      }
    });
    if (invalid) return { value: current, complete: false };
    if (decoded === current) return { value: current, complete: true };
    current = decoded.replaceAll("+", " ");
  }
  return { value: current, complete: false };
}

function isLocalPathText(value) {
  const decoded = String(value).trim();
  return /^(?:file:(?:\/\/)?|~\/|\.\.?[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/i.test(
    decoded,
  );
}

function containsLocalPathValue(value) {
  const decoded = decodePercentRuns(value);
  if (!decoded.complete) return true;
  if (isLocalPathText(decoded.value)) return true;
  return (
    /\bfile:(?:\/\/)?[^\s]+/i.test(decoded.value) ||
    /(^|[\s\[\{:`"'(=,>|;&])\.\.?[\\/][^\s]+/m.test(decoded.value) ||
    /(^|[\s\[\{:`"'(=,>|;&])[A-Za-z]:[\\/][^\s]+/m.test(decoded.value) ||
    /(^|[\s\[\{:`"'(=,>|;&])\/(?!\/)[^\s]+/m.test(decoded.value) ||
    /(^|[\s\[\{:`"'(=,>|;&])\\\\[^\\\s]+\\[^\s]+/m.test(decoded.value) ||
    /(^|[\s\[\{:`"'(=,>|;&])~\/[^\s]+/m.test(decoded.value)
  );
}

function sanitizeNetworkUrl(url, stats) {
  let changed = false;
  const sanitized = url.replace(
    /([?&#])(?:([^=&#\s]*)=([^&#\s]*)|([^=&#\s]+))/g,
    (whole, delimiter, assignedKey, value, flagKey) => {
      const key = assignedKey ?? flagKey;
      if (containsLocalPathValue(key)) {
        changed = true;
        return `${delimiter}[LOCAL_PATH]`;
      }
      if (assignedKey !== undefined && containsLocalPathValue(value)) {
        changed = true;
        return `${delimiter}${key}=[LOCAL_PATH]`;
      }
      return whole;
    },
  );
  if (changed) stats.redactions++;
  return sanitized;
}

function transformWithoutHttpUrls(text, transform, stats) {
  const urls = [];
  const protectedText = text.replace(/\bhttps?:\/\/[^\s`"'<>]+/gi, (url) => {
    const punctuation = /[\])},.;!?]+$/.exec(url)?.[0] ?? "";
    const coreUrl = punctuation ? url.slice(0, -punctuation.length) : url;
    const key = `BEAMNETWORKURL${urls.length}END`;
    const sanitized = stats ? sanitizeNetworkUrl(coreUrl, stats) : coreUrl;
    urls.push(`${sanitized}${punctuation}`);
    return key;
  });
  const transformed = transform(protectedText);
  if (typeof transformed !== "string") return transformed;
  return transformed.replace(
    /BEAMNETWORKURL(\d+)END/g,
    (_match, index) => urls[Number(index)],
  );
}

function redactLocalPaths(text, stats) {
  let next = text;
  next = replaceTracked(
    next,
    /(["'])(?:file:(?:\/\/)?|\.\.?[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^"'\r\n]+\1/gi,
    "[LOCAL_PATH]",
    stats,
  );
  next = replaceTracked(
    next,
    /\bfile:(?:\/\/)?[^\s`"'<>),;]+/gi,
    "[LOCAL_PATH]",
    stats,
  );
  next = transformWithoutHttpUrls(next, (value) => {
    let transformed = value;
    transformed = replaceTracked(
      transformed,
      /(^|[\s\[\{:`"'(=,>|;&])(\.\.?[\\/][^\s`"'<>),;]+)/gm,
      "$1[LOCAL_PATH]",
      stats,
    );
    transformed = replaceTracked(
      transformed,
      /(^|[\s\[\{:`"'(=,>|;&])([A-Za-z]:[\\/](?:(?:[^\\/\r\n,;`"'<>]+[\\/])+[^\\/\s\r\n,;`"'<>]+|[^\\/\s\r\n,;`"'<>]+))/gm,
      "$1[LOCAL_PATH]",
      stats,
    );
    transformed = replaceTracked(
      transformed,
      /(^|[\s\[\{:`"'(=,>|;&])(\/(?:(?:[^/\r\n,;`"'<>]+\/)+[^/\s\r\n,;`"'<>]+|[^/\s\r\n,;`"'<>]+))/gm,
      "$1[LOCAL_PATH]",
      stats,
    );
    transformed = replaceTracked(
      transformed,
      /(^|[\s\[\{:`"'(=,>|;&])(\\\\[^\\\r\n,;`"'<>]+\\(?:[^\\\r\n,;`"'<>]+\\)*[^\\\s\r\n,;`"'<>]+)/gm,
      "$1[LOCAL_PATH]",
      stats,
    );
    transformed = replaceTracked(
      transformed,
      /~\/[^\s`"'<>),;]+/g,
      "[HOME_PATH]",
      stats,
    );
    return transformed;
  }, stats);
  return next;
}

function redactYamlSecretBlocks(text, stats) {
  const secretLine = new RegExp(
    `^(\\s*)(["']?)(${SECRET_FIELD})\\2\\s*:\\s*[|>]`,
    "i",
  );
  const plainSecretLine = new RegExp(
    `^(\\s*)(["']?)(${SECRET_FIELD})\\2\\s*:\\s*(?![|>])\\S.*$`,
    "i",
  );
  const lines = text.split(/\r?\n/);
  const output = [];
  for (let index = 0; index < lines.length; index++) {
    const match = secretLine.exec(lines[index]);
    if (!match) {
      const plainMatch = plainSecretLine.exec(lines[index]);
      if (plainMatch) {
        output.push(
          `${plainMatch[1]}${plainMatch[2]}${plainMatch[3]}${plainMatch[2]}: [REDACTED]`,
        );
        stats.redactions++;
      } else {
        output.push(lines[index]);
      }
      continue;
    }
    output.push(`${match[1]}${match[2]}${match[3]}${match[2]}: [REDACTED]`);
    const indentation = match[1].length;
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (!next.trim()) {
        index++;
        continue;
      }
      const nextIndentation = /^\s*/.exec(next)?.[0].length ?? 0;
      if (nextIndentation <= indentation) break;
      index++;
    }
    stats.redactions++;
  }
  return output.join("\n");
}

function secretBearingPattern() {
  return new RegExp(
    `(?:(?<![a-z0-9_-])["']?${SECRET_FIELD}["']?(?![a-z0-9_-])\\s*:\\s*|` +
      `(?<![a-z0-9_-])["']?${SECRET_FIELD}["']?(?![a-z0-9_-])\\s*=\\s*|` +
      `--${SECRET_FIELD}(?:=|\\s+))`,
    "i",
  );
}

function uppercasePassAssignmentName(line) {
  return /(?<![A-Z0-9_])([A-Z][A-Z0-9_]*PASS[A-Z0-9_]*|PASS[A-Z0-9_]*)\s*=\s*/.exec(
    line,
  )?.[1];
}

function hasUppercasePassSecret(line) {
  const name = uppercasePassAssignmentName(line);
  if (!name) return false;
  for (const benignRoot of ["BYPASS", "COMPASS", "PASSED", "PASSENGERS"]) {
    if (name === benignRoot) return false;
    if (!name.startsWith(`${benignRoot}_`)) continue;
    const suffix = name.slice(benignRoot.length + 1);
    return /(?:^|_)(?:PASS|PASSCODE|PASSPHRASE|PASS_PHRASE|PASSWORD|PASSWD)(?:_|$)/.test(
      suffix,
    );
  }
  return true;
}

function redactSecretBearingLines(text, stats) {
  const lines = text.split(/\r?\n/);
  const output = [];
  let changed = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!secretBearingPattern().test(line) && !hasUppercasePassSecret(line)) {
      output.push(line);
      continue;
    }
    changed = true;
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    output.push(`${indent}[REDACTED_SECRET_LINE]`);

    const expectsContinuation = /[:=]\s*\\?\s*(?:[\[{])?\s*,?\s*$/.test(line);
    if (!expectsContinuation) continue;
    let removedValue = false;
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (!next.trim()) {
        index++;
        continue;
      }
      const nextIndentation = /^\s*/.exec(next)?.[0].length ?? 0;
      if (removedValue && nextIndentation <= indent.length) break;
      index++;
      removedValue = true;
    }
  }
  if (changed) stats.redactions++;
  return output.join("\n");
}

function redact(input, stats) {
  let text = redactYamlSecretBlocks(stripInternalWrappers(input), stats);
  const fixedRules = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
    [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
    [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED_API_KEY]"],
    [/\b(?:whsec|npm)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
    [/\b(?:glpat|gldt|glft|glrt|glcbt|glptt|glsoat|gloas|glrtr|glimt|glagent|glwt|glffct)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
    [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_API_KEY]"],
    [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
    [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
    [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "[REDACTED_SLACK_TOKEN]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
    [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"],
    [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "[REDACTED_AUTH_HEADER]"],
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]"],
    [/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, "[REDACTED_PHONE]"],
    [/([?&#](?:token|key|secret|signature|sig|access_token|auth|password|passwd|api_key|client_secret)=)[^\s`"'>&#]+/gi, "$1[REDACTED]"],
  ];
  for (const [pattern, replacement] of fixedRules) {
    text = replaceTracked(text, pattern, replacement, stats);
  }

  text = redactSecretBearingLines(text, stats);
  text = replaceTracked(text, /\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED_OPAQUE_VALUE]", stats);
  text = replaceTracked(
    text,
    /\b[A-Za-z0-9_+/=-]{40,}\b/g,
    "[REDACTED_OPAQUE_VALUE]",
    stats,
  );
  return redactLocalPaths(text, stats);
}

function hasLocalPath(text) {
  const urlHasLocalPath = [...text.matchAll(/\bhttps?:\/\/[^\s`"'<>]+/gi)].some(
    ([url]) => sanitizeNetworkUrl(url, { redactions: 0 }) !== url,
  );
  if (urlHasLocalPath) return true;
  const pathPatterns = [
    /(["'])(?:file:(?:\/\/)?|\.\.?[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^"'\r\n]+\1/i,
    /\bfile:(?:\/\/)?[^\s]+/i,
    /(^|[\s\[\{:`"'(=,>|;&])\.\.?[\\/][^\s]+/m,
    /(^|[\s\[\{:`"'(=,>|;&])\/(?:(?:[^/\r\n,;`"'<>]+\/)+[^/\s\r\n,;`"'<>]+|[^/\s\r\n,;`"'<>]+)/m,
    /(^|[\s\[\{:`"'(=,>|;&])[A-Za-z]:[\\/](?:(?:[^\\/\r\n,;`"'<>]+[\\/])+[^\\/\s\r\n,;`"'<>]+|[^\\/\s\r\n,;`"'<>]+)/m,
    /(^|[\s\[\{:`"'(=,>|;&])\\\\[^\\\r\n,;`"'<>]+\\(?:[^\\\r\n,;`"'<>]+\\)*[^\\\s\r\n,;`"'<>]+/m,
    /~\/[^\s]+/,
  ];
  return transformWithoutHttpUrls(text, (value) =>
    pathPatterns.some((pattern) => pattern.test(value)),
  );
}

function unsafePatterns(text) {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    /\b(?:whsec|npm)_[A-Za-z0-9_-]{16,}\b/,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
    /\b[A-Fa-f0-9]{32,}\b/,
    /\b[A-Za-z0-9_+/=-]{40,}\b/,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\b(?:user_session|_gh_sess|__Host-user_session_same_site|GH_SESSION_TOKEN)\b/i,
    /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/,
    /\b(?:glpat|gldt|glft|glrt|glcbt|glptt|glsoat|gloas|glrtr|glimt|glagent|glwt|glffct)-[A-Za-z0-9_-]{16,}\b/,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
    /[?&#](?:token|key|secret|signature|sig|access_token|auth|password|passwd|api_key|client_secret)=(?!\[REDACTED\])[^\s&#]+/i,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(text)) || hasLocalPath(text)) {
    return ["unsafe"];
  }

  return secretBearingPattern().test(text) || text.split(/\r?\n/).some(hasUppercasePassSecret)
    ? ["unsafe"]
    : [];
}

export function sanitizeVisibleText(input, options = {}) {
  const stats = options.stats || { redactions: 0 };
  let text = stripInternalWrappers(input).replace(/\n{3,}/g, "\n\n").trim();
  if (!text || /<(?:system-reminder|local-command-caveat)\b/i.test(text) || isSetupText(text)) {
    return "";
  }
  text = redact(text, stats).replace(/\n{3,}/g, "\n\n").trim();
  if (unsafePatterns(text).length) throw new Error("unsafe transcript text remains after redaction");
  const maxChars = Number(options.maxChars || DEFAULT_ENTRY_MAX_CHARS);
  if (text.length <= maxChars) return text;
  let omitted = text.length - maxChars;
  while (true) {
    const marker = `\n...[truncated ${omitted} chars]`;
    if (marker.length >= maxChars) return marker.slice(0, maxChars);
    let cutoff = maxChars - marker.length;
    const lastCodeUnit = text.charCodeAt(cutoff - 1);
    const nextCodeUnit = text.charCodeAt(cutoff);
    if (
      lastCodeUnit >= 0xd800 &&
      lastCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff
    ) {
      cutoff--;
    }
    const visible = text.slice(0, cutoff).trimEnd();
    const nextOmitted = text.length - visible.length;
    if (nextOmitted === omitted) return `${visible}${marker}`;
    omitted = nextOmitted;
  }
}

function toolFamily(name) {
  const normalized = String(name || "tool").toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (["websearch", "browsersearch", "browseropen"].includes(compact)) return "network";
  if (["filechange", "applypatch", "filewrite"].includes(compact)) return "write";
  if (["commandexecution", "mcptoolcall"].includes(compact)) return "execute";
  if (/(web|http|browser|chrome|github|gmail|calendar)/.test(normalized)) return "network";
  if (/(write|edit|patch|apply|create|update|append|save|upload)/.test(normalized)) return "write";
  if (/(read|fetch|open|list|find|search|grep|rg|view|snapshot|screenshot)/.test(normalized)) return "read";
  if (/(exec|command|shell|run|test|build|lint|format|install|npm|pnpm|cargo|xcode)/.test(normalized)) return "execute";
  return "other";
}

function addTool(stats, name) {
  const family = toolFamily(name);
  stats.toolFamilies[family] = (stats.toolFamilies[family] || 0) + 1;
  stats.toolCalls++;
}

function pushMessage(items, type, input, stats, maxChars) {
  const text = sanitizeVisibleText(input, { stats, maxChars });
  if (text) items.push({ type, text });
}

function activeClaudeRows(rows) {
  const records = rows.filter(isRecord);
  const conversational = records.filter((row) => {
    if (typeof row.uuid !== "string") return false;
    const message = isRecord(row.message) ? row.message : row;
    const role = String(message.role || row.type || "").toLowerCase();
    return role === "user" || role === "assistant";
  });
  const hasMainConversation = conversational.some((row) => row.isSidechain !== true);
  const primary = hasMainConversation
    ? records.filter((row) => row.isSidechain !== true)
    : records;
  const primarySet = new Set(primary);
  const byUuid = new Map(
    primary
      .filter((row) => typeof row.uuid === "string")
      .map((row) => [row.uuid, row]),
  );
  const leaf = conversational.findLast((row) => primarySet.has(row));
  if (!leaf || typeof leaf.uuid !== "string") return primary;

  const chain = new Set();
  let current = leaf;
  while (current && typeof current.uuid === "string" && !chain.has(current.uuid)) {
    chain.add(current.uuid);
    if (current.type === "system" && current.subtype === "compact_boundary") {
      const metadata = isRecord(current.compactMetadata) ? current.compactMetadata : {};
      const preserved = isRecord(metadata.preservedMessages)
        ? metadata.preservedMessages
        : {};
      const uuids = Array.isArray(preserved.uuids)
        ? preserved.uuids
        : Array.isArray(preserved.allUuids)
          ? preserved.allUuids
          : [];
      for (const uuid of uuids) {
        if (typeof uuid === "string" && byUuid.has(uuid)) chain.add(uuid);
      }
    }
    const parentId =
      typeof current.parentUuid === "string"
        ? current.parentUuid
        : current.type === "system" &&
            current.subtype === "compact_boundary" &&
            typeof current.logicalParentUuid === "string"
          ? current.logicalParentUuid
          : undefined;
    current = parentId ? byUuid.get(parentId) : undefined;
  }
  return primary.filter((row) => typeof row.uuid === "string" && chain.has(row.uuid));
}

function parseClaude(rows, options) {
  const items = [];
  const stats = { redactions: 0, toolCalls: 0, toolOutputsDropped: 0, toolFamilies: {} };
  let identity = null;
  let sourceModel;
  for (const row of activeClaudeRows(rows)) {
    if (!isRecord(row)) continue;
    if (!identity && typeof row.sessionId === "string") identity = row.sessionId;
    if (row.isMeta === true || row.isCompactSummary === true || row.type === "summary" || row.type === "system") {
      continue;
    }
    const message = isRecord(row.message) ? row.message : row;
    if (message.isMeta === true || message.isCompactSummary === true) continue;
    const role = String(message.role || row.type || "").toLowerCase();
    // Claude assistant messages carry the Anthropic SDK's response model ID.
    if (role === "assistant") sourceModel = beamSourceModel("anthropic", message.model) || sourceModel;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use") addTool(stats, block.name || "tool_use");
        if (block.type === "tool_result") stats.toolOutputsDropped++;
      }
    }
    if (row.type === "tool_use") addTool(stats, row.name || "tool_use");
    if (row.type === "tool_result") stats.toolOutputsDropped++;
    if (role === "user") pushMessage(items, "userMessage", visibleText(content ?? message), stats, options.maxChars);
    if (role === "assistant") pushMessage(items, "agentMessage", visibleText(content ?? message), stats, options.maxChars);
  }
  return { source: "claude", identity, items, stats, ...(sourceModel ? { sourceModel } : {}) };
}

function beamSourceModel(provider, model) {
  if (typeof provider !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(provider) || typeof model !== "string" || !/^[a-z0-9][a-z0-9._:/-]{0,255}$/i.test(model) || sanitizeVisibleText(model, { maxChars: 256 }) !== model) return undefined;
  return { provider: provider.toLowerCase(), model };
}

function normalizedType(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function parseCodexItem(item, items, stats, options) {
  if (!isRecord(item)) return;
  const type = normalizedType(item.type);
  if (type === "usermessage") {
    pushMessage(items, "userMessage", visibleText(item.content ?? item.text ?? item.message), stats, options.maxChars);
    return;
  }
  if (type === "agentmessage") {
    pushMessage(items, "agentMessage", visibleText(item.content ?? item.text ?? item.message), stats, options.maxChars);
    return;
  }
  if (["reasoning", "plan", "contextcompaction", "compaction"].includes(type)) return;
  if (type.includes("output") || type.includes("result")) {
    stats.toolOutputsDropped++;
    return;
  }
  if (
    item.aggregatedOutput !== undefined ||
    item.output !== undefined ||
    item.result !== undefined
  ) {
    stats.toolOutputsDropped++;
  }
  addTool(stats, item.name || item.tool || item.type || "tool");
}

function parseCodex(rows, options) {
  const items = [];
  const stats = { redactions: 0, toolCalls: 0, toolOutputsDropped: 0, toolFamilies: {} };
  let identity = null;
  let provider;
  let sourceModel;
  const hasEventDialogue = rows.some((row) => {
    if (row?.type !== "event_msg") return false;
    const type = normalizedType(row?.payload?.type);
    if (type === "usermessage" || type === "agentmessage") return true;
    if (type === "itemcompleted") {
      const itemType = normalizedType(row?.payload?.item?.type);
      return itemType === "usermessage" || itemType === "agentmessage";
    }
    return false;
  });
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const payload = isRecord(row.payload) ? row.payload : {};
    if (row.type === "session_meta" && typeof payload.id === "string") {
      identity = payload.id;
      provider = payload.model_provider;
      continue;
    }
    if (row.type === "turn_context") {
      sourceModel = beamSourceModel(provider, payload.model) || sourceModel;
      continue;
    }
    if (row.type === "event_msg") {
      const type = normalizedType(payload.type);
      if (type === "usermessage") pushMessage(items, "userMessage", visibleText(payload.message ?? payload.content), stats, options.maxChars);
      else if (type === "agentmessage") pushMessage(items, "agentMessage", visibleText(payload.message ?? payload.content), stats, options.maxChars);
      else if (type === "itemcompleted") parseCodexItem(payload.item, items, stats, options);
      continue;
    }
    if (row.type !== "response_item") continue;
    const type = normalizedType(payload.type);
    if (type === "agentmessage") continue;
    if (payload.role === "user" || payload.role === "assistant") {
      if (hasEventDialogue) continue;
      pushMessage(
        items,
        payload.role === "user" ? "userMessage" : "agentMessage",
        visibleText(payload.content),
        stats,
        options.maxChars,
      );
      continue;
    }
    if (type === "reasoning") continue;
    if (type.includes("output")) stats.toolOutputsDropped++;
    else if (type) addTool(stats, payload.name || payload.type);
  }
  return { source: "codex", identity, items, stats, ...(sourceModel ? { sourceModel } : {}) };
}

function toolSummary(stats) {
  const order = ["read", "write", "execute", "network", "other"];
  const counts = order
    .filter((family) => stats.toolFamilies[family])
    .map((family) => `${stats.toolFamilies[family]} ${family}`);
  return `${counts.join(", ") || "0 tool"}; raw tool outputs dropped: ${stats.toolOutputsDropped}`;
}

function detectSource(rows, file) {
  if (rows.some((row) => row?.type === "session_meta" || row?.type === "response_item")) return "codex";
  if (rows.some((row) => row?.type === "user" || row?.type === "assistant" || row?.message?.role)) return "claude";
  if (file.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  return "claude";
}

export function renderSession(file, options = {}) {
  const resolved = fs.realpathSync(file);
  const { rows, truncated } = parseRows(resolved);
  const source = options.source || detectSource(rows, resolved);
  const parsed = source === "codex" ? parseCodex(rows, options) : parseClaude(rows, options);
  if (parsed.stats.toolCalls || parsed.stats.toolOutputsDropped) {
    parsed.items.push({ type: "other", text: toolSummary(parsed.stats) });
  }
  return { ...parsed, truncated, file: resolved };
}
