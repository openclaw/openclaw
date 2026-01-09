import { randomUUID } from "node:crypto";
import fs from "node:fs";

import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  resolveEmbeddedSessionLane,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import { clearCommandLane } from "../../process/command-queue.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
} from "../protocol/index.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import type { GatewayRequestHandlers } from "./types.js";

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
    const p = params as import("../protocol/index.js").SessionsListParams;
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
    const p = params as import("../protocol/index.js").SessionsResolveParams;
    const cfg = loadConfig();

    const key = typeof p.key === "string" ? p.key.trim() : "";
    const label = typeof p.label === "string" ? p.label.trim() : "";
    const hasKey = key.length > 0;
    const hasLabel = label.length > 0;
    if (hasKey && hasLabel) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Provide either key or label (not both)",
        ),
      );
      return;
    }
    if (!hasKey && !hasLabel) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Either key or label is required",
        ),
      );
      return;
    }

    if (hasKey) {
      if (!key) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
        );
        return;
      }
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const store = loadSessionStore(target.storePath);
      const existingKey = target.storeKeys.find(
        (candidate) => store[candidate],
      );
      if (!existingKey) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${key}`),
        );
        return;
      }
      respond(true, { ok: true, key: target.canonicalKey }, undefined);
      return;
    }

    if (!label) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "label required"),
      );
      return;
    }

    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const list = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: {
        includeGlobal: p.includeGlobal === true,
        includeUnknown: p.includeUnknown === true,
        label,
        agentId: p.agentId,
        spawnedBy: p.spawnedBy,
        limit: 2,
      },
    });
    if (list.sessions.length === 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `No session found with label: ${label}`,
        ),
      );
      return;
    }
    if (list.sessions.length > 1) {
      const keys = list.sessions.map((s) => s.key).join(", ");
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found with label: ${label} (${keys})`,
        ),
      );
      return;
    }
    respond(true, { ok: true, key: list.sessions[0]?.key }, undefined);
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
    const p = params as import("../protocol/index.js").SessionsPatchParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
      );
      return;
    }

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    const store = loadSessionStore(storePath);

    const primaryKey = target.storeKeys[0] ?? key;
    const existingKey = target.storeKeys.find((candidate) => store[candidate]);
    if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
      store[primaryKey] = store[existingKey];
      delete store[existingKey];
    }
    const applied = await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: primaryKey,
      patch: p,
      loadGatewayModelCatalog: context.loadGatewayModelCatalog,
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    await saveSessionStore(storePath, store);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
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
    const p = params as import("../protocol/index.js").SessionsResetParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
      );
      return;
    }

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    const store = loadSessionStore(storePath);
    const primaryKey = target.storeKeys[0] ?? key;
    const existingKey = target.storeKeys.find((candidate) => store[candidate]);
    if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
      store[primaryKey] = store[existingKey];
      delete store[existingKey];
    }
    const entry = store[primaryKey];
    const now = Date.now();
    const next: SessionEntry = {
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
      lastProvider: entry?.lastProvider,
      lastTo: entry?.lastTo,
      skillsSnapshot: entry?.skillsSnapshot,
    };
    store[primaryKey] = next;
    await saveSessionStore(storePath, store);
    respond(
      true,
      { ok: true, key: target.canonicalKey, entry: next },
      undefined,
    );
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
    const p = params as import("../protocol/index.js").SessionsDeleteParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
      );
      return;
    }

    const cfg = loadConfig();
    const mainKey = resolveMainSessionKey(cfg);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Cannot delete the main session (${mainKey}).`,
        ),
      );
      return;
    }

    const deleteTranscript =
      typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const storePath = target.storePath;
    const store = loadSessionStore(storePath);
    const primaryKey = target.storeKeys[0] ?? key;
    const existingKey = target.storeKeys.find((candidate) => store[candidate]);
    if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
      store[primaryKey] = store[existingKey];
      delete store[existingKey];
    }
    const entry = store[primaryKey];
    const sessionId = entry?.sessionId;
    const existed = Boolean(entry);
    clearCommandLane(resolveEmbeddedSessionLane(target.canonicalKey));
    if (sessionId && isEmbeddedPiRunActive(sessionId)) {
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
    if (existed) delete store[primaryKey];
    await saveSessionStore(storePath, store);

    const archived: string[] = [];
    if (deleteTranscript && sessionId) {
      for (const candidate of resolveSessionTranscriptCandidates(
        sessionId,
        storePath,
        entry?.sessionFile,
        target.agentId,
      )) {
        if (!fs.existsSync(candidate)) continue;
        try {
          archived.push(archiveFileOnDisk(candidate, "deleted"));
        } catch {
          // Best-effort.
        }
      }
    }

    respond(
      true,
      { ok: true, key: target.canonicalKey, deleted: existed, archived },
      undefined,
    );
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
    const p = params as import("../protocol/index.js").SessionsCompactParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
      );
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    const store = loadSessionStore(storePath);
    const primaryKey = target.storeKeys[0] ?? key;
    const existingKey = target.storeKeys.find((candidate) => store[candidate]);
    if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
      store[primaryKey] = store[existingKey];
      delete store[existingKey];
    }
    const entry = store[primaryKey];
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

    if (store[primaryKey]) {
      delete store[primaryKey].inputTokens;
      delete store[primaryKey].outputTokens;
      delete store[primaryKey].totalTokens;
      store[primaryKey].updatedAt = Date.now();
      await saveSessionStore(storePath, store);
    }

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
};
