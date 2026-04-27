import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { stripInternalRuntimeContext } from "../../agents/internal-runtime-context.js";
import { isHeartbeatUserMessage } from "../../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../auto-reply/heartbeat.js";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import { HEARTBEAT_TOKEN, isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import { isSessionArchiveArtifactName, isUsageCountedSessionTranscriptFileName, } from "../../config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { isExecCompletionEvent } from "../../infra/heartbeat-events-filter.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { hashText } from "./hash.js";
const DREAMING_NARRATIVE_RUN_PREFIX = "dreaming-narrative-";
// Keep the historical one-line-per-message export shape for normal turns, but
// wrap pathological long messages so downstream indexers never ingest a single
// toxic line. Wrapped continuation lines still map back to the same JSONL line.
// This limit applies to content only; the role label adds up to 11 chars.
const SESSION_EXPORT_CONTENT_WRAP_CHARS = 800;
const DIRECT_CRON_PROMPT_RE = /^\[cron:[^\]]+\]\s*/;
function isCheckpointTranscriptFileName(fileName) {
    return fileName.endsWith(".jsonl") && fileName.includes(".checkpoint.");
}
function shouldSkipTranscriptFileForDreaming(absPath) {
    const fileName = path.basename(absPath);
    return isSessionArchiveArtifactName(fileName) || isCheckpointTranscriptFileName(fileName);
}
function isDreamingNarrativeBootstrapRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        return false;
    }
    const candidate = record;
    if (candidate.type !== "custom" ||
        candidate.customType !== "openclaw:bootstrap-context:full" ||
        !candidate.data ||
        typeof candidate.data !== "object" ||
        Array.isArray(candidate.data)) {
        return false;
    }
    const runId = candidate.data.runId;
    return typeof runId === "string" && runId.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}
function hasDreamingNarrativeRunId(value) {
    return typeof value === "string" && value.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}
function isDreamingNarrativeGeneratedRecord(record) {
    if (isDreamingNarrativeBootstrapRecord(record)) {
        return true;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        return false;
    }
    const candidate = record;
    if (hasDreamingNarrativeRunId(candidate.runId) ||
        hasDreamingNarrativeRunId(candidate.sessionKey)) {
        return true;
    }
    if (!candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) {
        return false;
    }
    const nested = candidate.data;
    return hasDreamingNarrativeRunId(nested.runId) || hasDreamingNarrativeRunId(nested.sessionKey);
}
function isDreamingNarrativeSessionStoreKey(sessionKey) {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
        return false;
    }
    const firstSeparator = trimmed.indexOf(":");
    if (firstSeparator < 0) {
        return trimmed.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
    }
    const secondSeparator = trimmed.indexOf(":", firstSeparator + 1);
    const sessionSegment = secondSeparator < 0 ? trimmed : trimmed.slice(secondSeparator + 1);
    return sessionSegment.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}
function normalizeComparablePath(pathname) {
    const resolved = path.resolve(pathname);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function normalizeSessionTranscriptPathForComparison(pathname) {
    return normalizeComparablePath(pathname);
}
function resolveSessionStoreTranscriptPath(sessionsDir, entry) {
    if (typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0) {
        const sessionFile = entry.sessionFile.trim();
        const resolved = path.isAbsolute(sessionFile)
            ? sessionFile
            : path.resolve(sessionsDir, sessionFile);
        return normalizeComparablePath(resolved);
    }
    if (typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0) {
        return normalizeComparablePath(path.join(sessionsDir, `${entry.sessionId.trim()}.jsonl`));
    }
    return null;
}
export function loadDreamingNarrativeTranscriptPathSetForSessionsDir(sessionsDir) {
    return loadSessionTranscriptClassificationForSessionsDir(sessionsDir)
        .dreamingNarrativeTranscriptPaths;
}
export function loadSessionTranscriptClassificationForSessionsDir(sessionsDir) {
    const storePath = path.join(sessionsDir, "sessions.json");
    const store = readSessionTranscriptClassificationStore(storePath);
    const dreamingTranscriptPaths = new Set();
    const cronRunTranscriptPaths = new Set();
    for (const [sessionKey, entry] of Object.entries(store)) {
        const transcriptPath = resolveSessionStoreTranscriptPath(sessionsDir, entry);
        if (!transcriptPath) {
            continue;
        }
        if (isDreamingNarrativeSessionStoreKey(sessionKey)) {
            dreamingTranscriptPaths.add(transcriptPath);
        }
        if (isCronRunSessionKey(sessionKey)) {
            cronRunTranscriptPaths.add(transcriptPath);
        }
    }
    return {
        dreamingNarrativeTranscriptPaths: dreamingTranscriptPaths,
        cronRunTranscriptPaths,
    };
}
function readSessionTranscriptClassificationStore(storePath) {
    try {
        const parsed = JSON.parse(fsSync.readFileSync(storePath, "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        return parsed;
    }
    catch {
        return {};
    }
}
export function loadDreamingNarrativeTranscriptPathSetForAgent(agentId) {
    return loadSessionTranscriptClassificationForAgent(agentId).dreamingNarrativeTranscriptPaths;
}
export function loadSessionTranscriptClassificationForAgent(agentId) {
    return loadSessionTranscriptClassificationForSessionsDir(resolveSessionTranscriptsDirForAgent(agentId));
}
function classifySessionTranscriptFromSessionStore(absPath) {
    const sessionsDir = path.dirname(absPath);
    const normalizedAbsPath = normalizeComparablePath(absPath);
    const classification = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);
    return {
        generatedByDreamingNarrative: classification.dreamingNarrativeTranscriptPaths.has(normalizedAbsPath),
        generatedByCronRun: classification.cronRunTranscriptPaths.has(normalizedAbsPath),
    };
}
export async function listSessionFilesForAgent(agentId) {
    const dir = resolveSessionTranscriptsDirForAgent(agentId);
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .filter((name) => isUsageCountedSessionTranscriptFileName(name))
            .map((name) => path.join(dir, name));
    }
    catch {
        return [];
    }
}
export function sessionPathForFile(absPath) {
    return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}
async function logSessionFileReadFailure(absPath, err) {
    const { createSubsystemLogger } = await import("../../logging/subsystem.js");
    createSubsystemLogger("memory").debug(`Failed reading session file ${absPath}: ${String(err)}`);
}
function normalizeSessionText(value) {
    return value
        .replace(/\s*\n+\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function collectRawSessionText(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const record = block;
        if (record.type === "text" && typeof record.text === "string") {
            parts.push(record.text);
        }
    }
    return parts.length > 0 ? parts.join("\n") : null;
}
function isHighSurrogate(code) {
    return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code) {
    return code >= 0xdc00 && code <= 0xdfff;
}
function splitLongSessionLine(text, maxChars = SESSION_EXPORT_CONTENT_WRAP_CHARS) {
    const normalized = text.trim();
    if (!normalized) {
        return [];
    }
    if (normalized.length <= maxChars) {
        return [normalized];
    }
    const segments = [];
    let cursor = 0;
    while (cursor < normalized.length) {
        const remaining = normalized.length - cursor;
        if (remaining <= maxChars) {
            segments.push(normalized.slice(cursor).trim());
            break;
        }
        const limit = cursor + maxChars;
        let splitAt = limit;
        for (let index = limit; index > cursor; index -= 1) {
            if (normalized[index] === " ") {
                splitAt = index;
                break;
            }
        }
        if (splitAt < normalized.length &&
            splitAt > cursor &&
            isHighSurrogate(normalized.charCodeAt(splitAt - 1)) &&
            isLowSurrogate(normalized.charCodeAt(splitAt))) {
            splitAt -= 1;
        }
        segments.push(normalized.slice(cursor, splitAt).trim());
        cursor = splitAt;
        while (cursor < normalized.length && normalized[cursor] === " ") {
            cursor += 1;
        }
    }
    return segments.filter(Boolean);
}
function renderSessionExportLines(label, text) {
    return splitLongSessionLine(text).map((segment) => `${label}: ${segment}`);
}
/**
 * Strip OpenClaw-injected inbound metadata envelopes from a raw text block.
 *
 * User-role messages arriving from external channels (Telegram, Discord,
 * Slack, …) are stored with a multi-line prefix containing Conversation info,
 * Sender info, and other AI-facing metadata blocks. These envelopes must be
 * removed BEFORE normalization, because `stripInboundMetadata` relies on
 * newline structure and fenced `json` code fences to locate sentinels; once
 * `normalizeSessionText` collapses newlines into spaces, stripping is
 * impossible.
 *
 * See: https://github.com/openclaw/openclaw/issues/63921
 */
function stripInboundMetadataForUserRole(text, role) {
    if (role !== "user") {
        return text;
    }
    return stripInboundMetadata(text);
}
const GENERATED_SYSTEM_MESSAGE_RE = /^System(?: \(untrusted\))?: \[[^\]]+\]\s*/;
function isGeneratedSystemWrapperMessage(text, role) {
    if (role !== "user") {
        return false;
    }
    return GENERATED_SYSTEM_MESSAGE_RE.test(text);
}
function isGeneratedCronPromptMessage(text, role) {
    if (role !== "user") {
        return false;
    }
    return DIRECT_CRON_PROMPT_RE.test(text);
}
function isGeneratedHeartbeatPromptMessage(text, role) {
    return role === "user" && isHeartbeatUserMessage({ role, content: text }, HEARTBEAT_PROMPT);
}
function sanitizeSessionText(text, role) {
    const strippedInbound = stripInboundMetadataForUserRole(text, role);
    const strippedInternal = stripInternalRuntimeContext(strippedInbound);
    const normalized = normalizeSessionText(strippedInternal);
    if (!normalized) {
        return null;
    }
    if (isGeneratedSystemWrapperMessage(normalized, role)) {
        return null;
    }
    if (isGeneratedCronPromptMessage(normalized, role)) {
        return null;
    }
    if (isGeneratedHeartbeatPromptMessage(normalized, role)) {
        return null;
    }
    if (isSilentReplyPayloadText(normalized)) {
        return null;
    }
    // Assistant-side machinery acks: HEARTBEAT_OK is the canonical "all clear,
    // nothing to do" reply to a heartbeat tick. Drop on the assistant side
    // directly so we do not have to rely on cross-message coupling with the
    // preceding user message (which a real user could spoof).
    if (role === "assistant" && normalized === HEARTBEAT_TOKEN) {
        return null;
    }
    const withoutSystemEnvelope = normalized.replace(GENERATED_SYSTEM_MESSAGE_RE, "").trim();
    if (isExecCompletionEvent(withoutSystemEnvelope)) {
        return null;
    }
    return normalized;
}
export function extractSessionText(content, role = "assistant") {
    const rawText = collectRawSessionText(content);
    if (rawText === null) {
        return null;
    }
    return sanitizeSessionText(rawText, role);
}
function parseSessionTimestampMs(record, message) {
    const candidates = [message.timestamp, record.timestamp];
    for (const value of candidates) {
        if (typeof value === "number" && Number.isFinite(value)) {
            const ms = value > 0 && value < 1e11 ? value * 1000 : value;
            if (Number.isFinite(ms) && ms > 0) {
                return ms;
            }
        }
        if (typeof value === "string") {
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }
    }
    return 0;
}
export async function buildSessionEntry(absPath, opts = {}) {
    try {
        const stat = await fs.stat(absPath);
        if (shouldSkipTranscriptFileForDreaming(absPath)) {
            return {
                path: sessionPathForFile(absPath),
                absPath,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                hash: hashText("\n\n"),
                content: "",
                lineMap: [],
                messageTimestampsMs: [],
            };
        }
        const raw = await fs.readFile(absPath, "utf-8");
        const lines = raw.split("\n");
        const collected = [];
        const lineMap = [];
        const messageTimestampsMs = [];
        const sessionStoreClassification = opts.generatedByDreamingNarrative === undefined || opts.generatedByCronRun === undefined
            ? classifySessionTranscriptFromSessionStore(absPath)
            : null;
        let generatedByDreamingNarrative = opts.generatedByDreamingNarrative ??
            sessionStoreClassification?.generatedByDreamingNarrative ??
            false;
        const generatedByCronRun = opts.generatedByCronRun ?? sessionStoreClassification?.generatedByCronRun ?? false;
        for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
            const line = lines[jsonlIdx];
            if (!line.trim()) {
                continue;
            }
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!generatedByDreamingNarrative && isDreamingNarrativeGeneratedRecord(record)) {
                generatedByDreamingNarrative = true;
            }
            if (!record ||
                typeof record !== "object" ||
                record.type !== "message") {
                continue;
            }
            const message = record.message;
            if (!message || typeof message.role !== "string") {
                continue;
            }
            if (message.role !== "user" && message.role !== "assistant") {
                continue;
            }
            const rawText = collectRawSessionText(message.content);
            if (rawText === null) {
                continue;
            }
            const text = sanitizeSessionText(rawText, message.role);
            if (!text) {
                // Assistant-side machinery (silent replies, system wrappers) is already
                // dropped by sanitizeSessionText. We deliberately do NOT use the prior
                // user message's pattern-match to drop the next assistant message:
                // user-typed text can match those same patterns (`[cron:...]`,
                // `System (untrusted): ...`) and a cross-message drop would let users
                // exfiltrate real assistant replies from the dreaming corpus by
                // prefixing their own prompt. See PR #70737 review (aisle-research-bot).
                continue;
            }
            if (generatedByDreamingNarrative || generatedByCronRun) {
                continue;
            }
            const safe = redactSensitiveText(text, { mode: "tools" });
            const label = message.role === "user" ? "User" : "Assistant";
            const renderedLines = renderSessionExportLines(label, safe);
            const timestampMs = parseSessionTimestampMs(record, message);
            collected.push(...renderedLines);
            lineMap.push(...renderedLines.map(() => jsonlIdx + 1));
            messageTimestampsMs.push(...renderedLines.map(() => timestampMs));
        }
        const content = collected.join("\n");
        return {
            path: sessionPathForFile(absPath),
            absPath,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            hash: hashText(content + "\n" + lineMap.join(",") + "\n" + messageTimestampsMs.join(",")),
            content,
            lineMap,
            messageTimestampsMs,
            ...(generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
            ...(generatedByCronRun ? { generatedByCronRun: true } : {}),
        };
    }
    catch (err) {
        void logSessionFileReadFailure(absPath, err);
        return null;
    }
}
