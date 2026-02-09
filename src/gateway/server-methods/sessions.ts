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
  validateSessionsListDeletedParams,
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
      const candidates = resolveSessionTranscriptCandidates(
        sessionId,
        storePath,
        entry?.sessionFile,
        target.agentId,
      );

      // If no transcript files exist but we have metadata, create one with just the metadata
      const existingFiles = candidates.filter((c) => fs.existsSync(c));
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
            // Append session metadata to the transcript file before archiving
            if (entry) {
              const metadataLine = JSON.stringify({ __session_metadata__: entry }) + "\n";
              fs.appendFileSync(candidate, metadataLine, "utf-8");
            }
            archived.push(archiveFileOnDisk(candidate, "deleted"));
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
  "sessions.list.deleted": async ({ params, respond }) => {
    if (!validateSessionsListDeletedParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.list.deleted params: ${formatValidationErrors(validateSessionsListDeletedParams.errors)}`,
        ),
      );
      return;
    }

    const p = params;
    const cfg = loadConfig();

    const agentId = normalizeAgentId(p.agentId ?? resolveDefaultAgentId(cfg));
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionsDir = path.join(agentDir, "sessions");

    try {
      if (!fs.existsSync(sessionsDir)) {
        respond(true, { ok: true, deleted: [] }, undefined);
        return;
      }

      const files = fs.readdirSync(sessionsDir);
      const deletedFiles = files.filter((f) => f.includes(".jsonl.deleted."));

      const deleted = deletedFiles
        .map((file) => {
          const fullPath = path.join(sessionsDir, file);
          const stat = fs.statSync(fullPath);
          // Extract sessionId from filename: <sessionId>.jsonl.deleted.<timestamp>
          const match = file.match(/^([0-9a-f-]{36})\.jsonl\.deleted\./i);
          const sessionId = match ? match[1] : null;

          // Extract timestamp from filename
          const timestampMatch = file.match(/\.deleted\.(.+)$/);
          const timestamp = timestampMatch ? timestampMatch[1] : null;

          // Try to read metadata from the file
          let metadata: unknown = null;
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            const lines = content.split("\n").filter((line) => line.trim());
            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1];
              try {
                const parsed = JSON.parse(lastLine);
                if (parsed.__session_metadata__) {
                  metadata = parsed.__session_metadata__;
                }
              } catch {
                // Last line isn't valid JSON or doesn't have metadata
              }
            }
          } catch {
            // File read error, skip this file
          }

          const isValidMetadata =
            metadata && typeof metadata === "object" && !Array.isArray(metadata);
          const metadataObj = isValidMetadata ? (metadata as Record<string, unknown>) : null;

          return {
            sessionId,
            file,
            path: fullPath,
            size: stat.size,
            deletedAt: timestamp,
            mtime: stat.mtimeMs,
            metadata: metadataObj,
            label:
              metadataObj && typeof metadataObj.label === "string" ? metadataObj.label : undefined,
            description:
              metadataObj && typeof metadataObj.description === "string"
                ? metadataObj.description
                : undefined,
            persistent:
              metadataObj && typeof metadataObj.persistent === "boolean"
                ? metadataObj.persistent
                : undefined,
          };
        })
        .filter((item) => item.sessionId != null && item.metadata != null)
        .toSorted((a, b) => b.mtime - a.mtime);

      const limit = p.limit ?? 50;
      const result = deleted.slice(0, limit);

      respond(true, { ok: true, deleted: result }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to list deleted sessions: ${String(err)}`),
      );
    }
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
    const sessionsDir = path.join(agentDir, "sessions");

    try {
      // Find the deleted file for this sessionId
      const files = fs.readdirSync(sessionsDir);
      const deletedFile = files.find((f) => f.startsWith(`${sessionId}.jsonl.deleted.`));

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

      // Read the deleted file to extract metadata
      const fileContent = fs.readFileSync(deletedPath, "utf-8");
      const lines = fileContent.split("\n").filter((line) => line.trim());

      // Look for metadata line at the end
      let metadata: unknown = null;
      let transcriptLines = lines;

      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        try {
          const parsed = JSON.parse(lastLine);
          if (parsed.__session_metadata__) {
            metadata = parsed.__session_metadata__;
            // Remove metadata line from transcript
            transcriptLines = lines.slice(0, -1);
          }
        } catch {
          // Last line isn't metadata, that's fine
        }
      }

      // Write the transcript file without metadata line
      fs.writeFileSync(
        restoredPath,
        transcriptLines.join("\n") + (transcriptLines.length > 0 ? "\n" : ""),
        "utf-8",
      );

      // Delete the old archived file
      fs.unlinkSync(deletedPath);

      // Restore session entry in sessions.json
      const sessionKey = `agent:${agentId}:${sessionId}`;
      const storePath = path.join(sessionsDir, "sessions.json");

      await updateSessionStore(storePath, (store) => {
        const isValidMetadata =
          metadata && typeof metadata === "object" && !Array.isArray(metadata);
        if (isValidMetadata) {
          // Restore full metadata
          store[sessionKey] = {
            ...(metadata as Record<string, unknown>),
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
