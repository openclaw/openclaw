import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../../agents/pi-embedded.js";
import { stopSubagentsForRequester } from "../../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  snapshotSessionOrigin,
  resolveMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsCompactParams,
  validateSessionsCreateParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateSessionsRestoreParams,
} from "../protocol/index.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!validateSessionsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    respond(true, result, undefined);
  },
  "sessions.preview": ({ params, respond }) => {
    if (!validateSessionsPreviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.preview params: ${formatValidationErrors(
            validateSessionsPreviewParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const target = resolveGatewaySessionStoreTarget({ cfg, key });
        const store = storeCache.get(target.storePath) ?? loadSessionStore(target.storePath);
        storeCache.set(target.storePath, store);
        const entry =
          target.storeKeys.map((candidate) => store[candidate]).find(Boolean) ??
          store[target.canonicalKey];
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": ({ params, respond }) => {
    if (!validateSessionsResolveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.resolve params: ${formatValidationErrors(validateSessionsResolveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.patch": async ({ params, respond, context }) => {
    if (!validateSessionsPatchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    const applied = await updateSessionStore(storePath, async (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
  },
  "sessions.reset": async ({ params, respond }) => {
    if (!validateSessionsResetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;

    // Check if session is persistent before allowing reset
    const store = loadSessionStore(storePath);
    const primaryKey = target.storeKeys[0] ?? key;
    const existingKey = target.storeKeys.find((candidate) => store[candidate]);
    const entry = store[existingKey ?? primaryKey];

    if (entry?.persistent === true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Cannot reset persistent session "${entry.label || key}". Use sessions.delete to clear it, or switch to a different session.`,
        ),
      );
      return;
    }

    const next = await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      const entry = store[primaryKey];
      const now = Date.now();
      const nextEntry: SessionEntry = {
        sessionId: randomUUID(),
        updatedAt: now,
        systemSent: false,
        abortedLastRun: false,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        responseUsage: entry?.responseUsage,
        model: entry?.model,
        contextTokens: entry?.contextTokens,
        sendPolicy: entry?.sendPolicy,
        label: entry?.label,
        origin: snapshotSessionOrigin(entry),
        lastChannel: entry?.lastChannel,
        lastTo: entry?.lastTo,
        skillsSnapshot: entry?.skillsSnapshot,
        // Reset token counts to 0 on session reset (#1523)
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      store[primaryKey] = nextEntry;
      return nextEntry;
    });
    respond(true, { ok: true, key: target.canonicalKey, entry: next }, undefined);
  },
  "sessions.delete": async ({ params, respond }) => {
    if (!validateSessionsDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const mainKey = resolveMainSessionKey(cfg);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const storePath = target.storePath;
    const { entry } = loadSessionEntry(key);
    const sessionId = entry?.sessionId;
    const existed = Boolean(entry);
    const queueKeys = new Set<string>(target.storeKeys);
    queueKeys.add(target.canonicalKey);
    if (sessionId) {
      queueKeys.add(sessionId);
    }
    clearSessionQueues([...queueKeys]);
    stopSubagentsForRequester({ cfg, requesterSessionKey: target.canonicalKey });
    if (sessionId) {
      abortEmbeddedPiRun(sessionId);
      const ended = await waitForEmbeddedPiRunEnd(sessionId, 15_000);
      if (!ended) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${key} is still active; try again in a moment.`,
          ),
        );
        return;
      }
    }
    await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      if (store[primaryKey]) {
        delete store[primaryKey];
      }
    });

    const archived: string[] = [];
    if (deleteTranscript && sessionId) {
      // Clean up old .deleted archives for this sessionId before creating a new one.
      // We intentionally keep only the most recent archive per session — restore
      // always operates on the latest delete, and stale archives would cause
      // duplicates in the deleted sessions list.
      const agentDir = resolveAgentDir(cfg, target.agentId);
      // resolveAgentDir returns ~/.openclaw/agents/{agentId}/agent
      // We need ~/.openclaw/agents/{agentId}/sessions
      const agentScope = path.dirname(agentDir);
      const sessionsDir = path.join(agentScope, "sessions");
      try {
        const files = fs.readdirSync(sessionsDir);
        const oldDeleted = files.filter((f) => f.startsWith(`${sessionId}.jsonl.deleted.`));
        for (const oldFile of oldDeleted) {
          try {
            fs.unlinkSync(path.join(sessionsDir, oldFile));
          } catch {
            // Best-effort cleanup
          }
        }
      } catch {
        // Directory might not exist, that's fine
      }

      const candidates = resolveSessionTranscriptCandidates(
        sessionId,
        storePath,
        entry?.sessionFile,
        target.agentId,
      );

      // Deduplicate candidates to avoid archiving the same file multiple times
      const uniqueCandidates = Array.from(new Set(candidates));

      // If no transcript files exist but we have metadata, create one with just the metadata
      const existingFiles = uniqueCandidates.filter((c) => fs.existsSync(c));
      if (existingFiles.length === 0 && entry && candidates.length > 0) {
        const metadataFile = candidates[0];
        try {
          const metadataLine = JSON.stringify({ __session_metadata__: entry }) + "\n";
          fs.writeFileSync(metadataFile, metadataLine, "utf-8");
          archived.push(archiveFileOnDisk(metadataFile, "deleted"));
        } catch {
          // Best-effort.
        }
      } else {
        // Archive existing transcript files
        for (const candidate of existingFiles) {
          try {
            // Archive the file first (without mutating the original)
            const archivedPath = archiveFileOnDisk(candidate, "deleted");
            archived.push(archivedPath);
            // Append metadata to the archived copy only
            if (entry) {
              const metadataLine = JSON.stringify({ __session_metadata__: entry }) + "\n";
              fs.appendFileSync(archivedPath, metadataLine, "utf-8");
            }
          } catch {
            // Best-effort.
          }
        }
      }
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted: existed, archived }, undefined);
  },
  "sessions.create": async ({ params, respond }) => {
    if (!validateSessionsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.create params: ${formatValidationErrors(validateSessionsCreateParams.errors)}`,
        ),
      );
      return;
    }

    const p = params;
    const label = String(p.label ?? "").trim();
    if (!label) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "label required"));
      return;
    }

    const cfg = loadConfig();
    const agentId = normalizeAgentId(p.agentId ?? resolveDefaultAgentId(cfg));

    // Generate unique session key
    const sessionId = randomUUID();
    const sessionKey = `agent:${agentId}:named:${sessionId}`;

    const now = Date.now();
    const persistent = p.persistent !== false; // default to true

    // Copy settings from basedOn session if provided
    let baseEntry: SessionEntry | undefined;
    if (p.basedOn) {
      try {
        const baseTarget = resolveGatewaySessionStoreTarget({ cfg, key: p.basedOn });
        const baseStore = loadSessionStore(baseTarget.storePath);
        baseEntry = baseStore[baseTarget.storeKeys[0] ?? p.basedOn];
      } catch {
        // If basedOn session not found, just proceed without copying
      }
    }

    const entry: SessionEntry = {
      sessionId,
      updatedAt: now,
      createdAt: now,
      systemSent: false,
      abortedLastRun: false,
      persistent,
      userCreated: true,
      label,
      description: p.description?.trim(),
      // Copy preferences from base session if provided
      thinkingLevel: baseEntry?.thinkingLevel,
      verboseLevel: baseEntry?.verboseLevel,
      reasoningLevel: baseEntry?.reasoningLevel,
      elevatedLevel: baseEntry?.elevatedLevel,
      responseUsage: baseEntry?.responseUsage,
      modelOverride: baseEntry?.modelOverride,
      providerOverride: baseEntry?.providerOverride,
      // Start fresh with zero tokens
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
    };

    const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
    await updateSessionStore(target.storePath, (store) => {
      store[sessionKey] = entry;
    });

    respond(true, { ok: true, key: sessionKey, sessionId, entry }, undefined);
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!validateSessionsCompactParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      return { entry: store[primaryKey], primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
  },
  "sessions.restore": async ({ params, respond }) => {
    if (!validateSessionsRestoreParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.restore params: ${formatValidationErrors(validateSessionsRestoreParams.errors)}`,
        ),
      );
      return;
    }

    const p = params;
    const sessionId = String(p.sessionId ?? "").trim();
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId required"));
      return;
    }

    const cfg = loadConfig();
    const agentId = normalizeAgentId(p.agentId ?? resolveDefaultAgentId(cfg));
    const agentDir = resolveAgentDir(cfg, agentId);
    // resolveAgentDir returns ~/.openclaw/agents/{agentId}/agent
    // We need ~/.openclaw/agents/{agentId}/sessions
    const agentScope = path.dirname(agentDir);
    const sessionsDir = path.join(agentScope, "sessions");

    try {
      // Find the most recent deleted file for this sessionId.
      // sessions.delete cleans up older archives so there should only be one,
      // but we sort by timestamp descending as a safety measure.
      const files = fs.readdirSync(sessionsDir);
      const deletedFile = files
        .filter((f) => f.startsWith(`${sessionId}.jsonl.deleted.`))
        .toSorted()
        .pop();

      if (!deletedFile) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.NOT_FOUND, `No deleted session found for sessionId: ${sessionId}`),
        );
        return;
      }

      const deletedPath = path.join(sessionsDir, deletedFile);
      const restoredPath = path.join(sessionsDir, `${sessionId}.jsonl`);

      // Check if a session with this ID already exists
      if (fs.existsSync(restoredPath)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Session ${sessionId} already exists. Cannot restore.`,
          ),
        );
        return;
      }

      // Read only the tail of the file to extract metadata (avoid loading full transcript)
      const TAIL_SIZE = 8192; // Read last 8KB to find metadata
      const stat = fs.statSync(deletedPath);
      const fileSize = stat.size;
      let metadata: unknown = null;
      let hasMetadata = false;

      if (fileSize > 0) {
        const readSize = Math.min(TAIL_SIZE, fileSize);
        const buffer = Buffer.alloc(readSize);
        const fd = fs.openSync(deletedPath, "r");
        try {
          fs.readSync(fd, buffer, 0, readSize, fileSize - readSize);
          const tail = buffer.toString("utf-8");
          const lines = tail.split("\n");
          // Check last non-empty line for metadata
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) {
              continue;
            }
            try {
              const parsed = JSON.parse(line);
              if (parsed.__session_metadata__) {
                metadata = parsed.__session_metadata__;
                hasMetadata = true;
                break;
              }
            } catch {
              // Not JSON or not metadata
            }
            break; // Only check the last non-empty line
          }
        } finally {
          fs.closeSync(fd);
        }
      }

      // Copy the deleted file to restored path, removing metadata line if present
      if (hasMetadata && fileSize > 0) {
        // Stream copy, excluding the last line
        const input = fs.createReadStream(deletedPath, { encoding: "utf-8" });
        const output = fs.createWriteStream(restoredPath, { encoding: "utf-8" });
        let buffer = "";
        let lastLine = "";

        await new Promise<void>((resolve, reject) => {
          input.on("data", (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete line in buffer
            for (const line of lines) {
              if (lastLine) {
                output.write(lastLine + "\n");
              }
              lastLine = line;
            }
          });
          input.on("end", () => {
            // Don't write the last line (it's the metadata)
            if (buffer && buffer !== lastLine) {
              if (lastLine) {
                output.write(lastLine + "\n");
              }
            }
            output.end();
          });
          output.on("finish", resolve);
          input.on("error", reject);
          output.on("error", reject);
        });
      } else {
        // No metadata, just copy the file as-is
        fs.copyFileSync(deletedPath, restoredPath);
      }

      // Delete ALL archived files for this sessionId to prevent duplicates
      const allFiles = fs.readdirSync(sessionsDir);
      const allDeleted = allFiles.filter((f) => f.startsWith(`${sessionId}.jsonl.deleted.`));
      for (const oldFile of allDeleted) {
        try {
          fs.unlinkSync(path.join(sessionsDir, oldFile));
        } catch {
          // Best-effort cleanup
        }
      }

      // Restore session entry in sessions.json
      const storePath = path.join(sessionsDir, "sessions.json");

      // Determine the correct session key format
      let sessionKey: string;
      const isValidMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata);
      const metadataObj = isValidMetadata ? (metadata as Record<string, unknown>) : null;
      const isNamedSession = metadataObj && metadataObj.userCreated === true;

      if (isNamedSession) {
        // Named sessions use agent:agentId:named:sessionId format
        sessionKey = `agent:${agentId}:named:${sessionId}`;
      } else {
        // Regular sessions use agent:agentId:sessionId format
        sessionKey = `agent:${agentId}:${sessionId}`;
      }

      await updateSessionStore(storePath, (store) => {
        if (isValidMetadata && metadataObj) {
          // Restore full metadata
          store[sessionKey] = {
            ...metadataObj,
            sessionId, // Ensure sessionId is always set
            updatedAt: Date.now(),
            sessionFile: restoredPath,
          };
        } else {
          // Fallback to minimal entry if no metadata found
          store[sessionKey] = {
            sessionId,
            updatedAt: Date.now(),
            systemSent: false,
            abortedLastRun: false,
            sessionFile: restoredPath,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            contextTokens: 0,
          };
        }
      });

      respond(true, { ok: true, key: sessionKey, sessionId, restored: deletedFile }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to restore session: ${String(err)}`),
      );
    }
  },
};
