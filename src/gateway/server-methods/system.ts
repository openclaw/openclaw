import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfiguredModelRef } from "../../agents/model-selection.js";
import { resolveProjectsRootDir } from "../../agents/projects.js";
import { getBrowserControlState } from "../../browser/control-service.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { getRedisConfig } from "../../infra/cache/redis.js";
import { getCacheBackend } from "../../infra/cache/unified-cache.js";
import { getDatabaseConfig } from "../../infra/database/client.js";
import { getSqlitePath } from "../../infra/database/sqlite-client.js";
import { getStorageBackend } from "../../infra/database/unified-store.js";
import { getLastHeartbeatEvent } from "../../infra/heartbeat-events.js";
import { setHeartbeatsEnabled } from "../../infra/heartbeat-runner.js";
import { enqueueSystemEvent, isSystemEventContextChanged } from "../../infra/system-events.js";
import { listSystemPresence, updateSystemPresence } from "../../infra/system-presence.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { resolveUserPath } from "../../utils.js";
import {
  ErrorCodes,
  errorShape,
  validateFsPickDirectoryParams,
  validateProjectsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const systemHandlers: GatewayRequestHandlers = {
  "system.info": ({ respond }) => {
    const cfg = loadConfig();
    const version = process.env.OPENCLAW_VERSION ?? process.env.npm_package_version ?? "dev";
    const hostname = os.hostname();

    // Model
    const modelRef = resolveConfiguredModelRef({
      cfg,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5-20250929",
    });
    const model = modelRef.provider ? `${modelRef.provider}/${modelRef.model}` : modelRef.model;

    // Storage backend
    const storageBackend = getStorageBackend();
    const storageDetails =
      storageBackend === "sqlite"
        ? getSqlitePath()
        : storageBackend === "postgresql"
          ? (() => {
              // If connected, surface the resolved host/db rather than guessing env names.
              try {
                const db = getDatabaseConfig();
                return `${db.database}@${db.host}:${db.port}`;
              } catch {
                return "configured";
              }
            })()
          : undefined;

    // Cache backend
    const cacheBackend = getCacheBackend();
    const redisConfig = cacheBackend === "redis" ? getRedisConfig() : null;

    // Browser service
    const browserState = getBrowserControlState();
    const browserProfiles = browserState
      ? Object.keys(browserState.resolved.profiles).length
      : null;

    // Log file
    const logSettings = getResolvedLoggerSettings();

    respond(
      true,
      {
        pid: process.pid,
        version,
        host: hostname,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        storage: {
          backend: storageBackend,
          details: storageDetails,
        },
        cache: {
          backend: cacheBackend,
          host: redisConfig?.host,
          port: redisConfig?.port,
        },
        model,
        browserProfiles,
        logFile: logSettings.file,
      },
      undefined,
    );
  },
  "last-heartbeat": ({ respond }) => {
    respond(true, getLastHeartbeatEvent(), undefined);
  },
  "set-heartbeats": ({ params, respond }) => {
    const enabled = params.enabled;
    if (typeof enabled !== "boolean") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid set-heartbeats params: enabled (boolean) required",
        ),
      );
      return;
    }
    setHeartbeatsEnabled(enabled);
    respond(true, { ok: true, enabled }, undefined);
  },
  "system-presence": ({ respond }) => {
    const presence = listSystemPresence();
    respond(true, presence, undefined);
  },
  "system-event": ({ params, respond, context }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "text required"));
      return;
    }
    const sessionKey = resolveMainSessionKeyFromConfig();
    const deviceId = typeof params.deviceId === "string" ? params.deviceId : undefined;
    const instanceId = typeof params.instanceId === "string" ? params.instanceId : undefined;
    const host = typeof params.host === "string" ? params.host : undefined;
    const ip = typeof params.ip === "string" ? params.ip : undefined;
    const mode = typeof params.mode === "string" ? params.mode : undefined;
    const version = typeof params.version === "string" ? params.version : undefined;
    const platform = typeof params.platform === "string" ? params.platform : undefined;
    const deviceFamily = typeof params.deviceFamily === "string" ? params.deviceFamily : undefined;
    const modelIdentifier =
      typeof params.modelIdentifier === "string" ? params.modelIdentifier : undefined;
    const lastInputSeconds =
      typeof params.lastInputSeconds === "number" && Number.isFinite(params.lastInputSeconds)
        ? params.lastInputSeconds
        : undefined;
    const reason = typeof params.reason === "string" ? params.reason : undefined;
    const roles =
      Array.isArray(params.roles) && params.roles.every((t) => typeof t === "string")
        ? params.roles
        : undefined;
    const scopes =
      Array.isArray(params.scopes) && params.scopes.every((t) => typeof t === "string")
        ? params.scopes
        : undefined;
    const tags =
      Array.isArray(params.tags) && params.tags.every((t) => typeof t === "string")
        ? params.tags
        : undefined;
    const presenceUpdate = updateSystemPresence({
      text,
      deviceId,
      instanceId,
      host,
      ip,
      mode,
      version,
      platform,
      deviceFamily,
      modelIdentifier,
      lastInputSeconds,
      reason,
      roles,
      scopes,
      tags,
    });
    const isNodePresenceLine = text.startsWith("Node:");
    if (isNodePresenceLine) {
      const next = presenceUpdate.next;
      const changed = new Set(presenceUpdate.changedKeys);
      const reasonValue = next.reason ?? reason;
      const normalizedReason = (reasonValue ?? "").toLowerCase();
      const ignoreReason =
        normalizedReason.startsWith("periodic") || normalizedReason === "heartbeat";
      const hostChanged = changed.has("host");
      const ipChanged = changed.has("ip");
      const versionChanged = changed.has("version");
      const modeChanged = changed.has("mode");
      const reasonChanged = changed.has("reason") && !ignoreReason;
      const hasChanges = hostChanged || ipChanged || versionChanged || modeChanged || reasonChanged;
      if (hasChanges) {
        const contextChanged = isSystemEventContextChanged(sessionKey, presenceUpdate.key);
        const parts: string[] = [];
        if (contextChanged || hostChanged || ipChanged) {
          const hostLabel = next.host?.trim() || "Unknown";
          const ipLabel = next.ip?.trim();
          parts.push(`Node: ${hostLabel}${ipLabel ? ` (${ipLabel})` : ""}`);
        }
        if (versionChanged) {
          parts.push(`app ${next.version?.trim() || "unknown"}`);
        }
        if (modeChanged) {
          parts.push(`mode ${next.mode?.trim() || "unknown"}`);
        }
        if (reasonChanged) {
          parts.push(`reason ${reasonValue?.trim() || "event"}`);
        }
        const deltaText = parts.join(" · ");
        if (deltaText) {
          enqueueSystemEvent(deltaText, {
            sessionKey,
            contextKey: presenceUpdate.key,
          });
        }
      }
    } else {
      enqueueSystemEvent(text, { sessionKey });
    }
    const nextPresenceVersion = context.incrementPresenceVersion();
    context.broadcast(
      "presence",
      { presence: listSystemPresence() },
      {
        dropIfSlow: true,
        stateVersion: {
          presence: nextPresenceVersion,
          health: context.getHealthVersion(),
        },
      },
    );
    respond(true, { ok: true }, undefined);
  },
  "projects.list": ({ params, respond }) => {
    if (!validateProjectsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid projects.list params"),
      );
      return;
    }
    const cfg = loadConfig();
    const requestedRoot = typeof params.rootDir === "string" ? params.rootDir : null;
    const includeHidden = typeof params.includeHidden === "boolean" ? params.includeHidden : false;

    const rootDirRaw =
      (requestedRoot && requestedRoot.trim()) ||
      resolveProjectsRootDir(cfg) ||
      (() => {
        const candidate = path.join(os.homedir(), "Desenvolvimento");
        try {
          return fs.statSync(candidate).isDirectory() ? candidate : undefined;
        } catch {
          return undefined;
        }
      })();
    if (!rootDirRaw) {
      respond(true, { rootDir: null, projects: [] }, undefined);
      return;
    }
    const resolvedRoot = path.resolve(resolveUserPath(String(rootDirRaw)));
    try {
      if (!fs.statSync(resolvedRoot).isDirectory()) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "rootDir is not a directory"),
        );
        return;
      }
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "rootDir not found"));
      return;
    }
    const searchRaw = typeof params.search === "string" ? params.search.trim().toLowerCase() : "";
    const limitRaw =
      typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 200;
    const limit = Math.max(1, Math.min(1000, Math.floor(limitRaw)));

    let entries: Array<{ name: string; path: string; isGitRepo: boolean }> = [];
    try {
      const dirents = fs.readdirSync(resolvedRoot, { withFileTypes: true });
      for (const d of dirents) {
        if (!d.isDirectory()) {
          continue;
        }
        const name = d.name;
        if (!name) {
          continue;
        }
        if (!includeHidden && name.startsWith(".")) {
          continue;
        }
        if (searchRaw && !name.toLowerCase().includes(searchRaw)) {
          continue;
        }
        const fullPath = path.join(resolvedRoot, name);
        const isGitRepo = fs.existsSync(path.join(fullPath, ".git"));
        entries.push({ name, path: fullPath, isGitRepo });
        if (entries.length >= limit) {
          break;
        }
      }
    } catch {
      respond(true, { rootDir: resolvedRoot, projects: [] }, undefined);
      return;
    }
    entries = entries.toSorted((a, b) => a.name.localeCompare(b.name));
    respond(true, { rootDir: resolvedRoot, projects: entries }, undefined);
  },

  "fs.pickDirectory": ({ params, respond }) => {
    if (!validateFsPickDirectoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid fs.pickDirectory params"),
      );
      return;
    }
    if (process.platform !== "darwin") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fs.pickDirectory only supported on macOS"),
      );
      return;
    }
    const prompt =
      typeof params.prompt === "string" && params.prompt.trim()
        ? params.prompt.trim()
        : "Select a folder";
    const defaultDir =
      typeof params.defaultDir === "string" && params.defaultDir.trim()
        ? resolveUserPath(params.defaultDir.trim())
        : null;

    try {
      const applescriptParts = [
        'tell application "System Events" to activate',
        defaultDir
          ? `set theFolder to (choose folder with prompt "${prompt.replaceAll('"', '\\"')}" default location POSIX file "${defaultDir.replaceAll('"', '\\"')}")`
          : `set theFolder to (choose folder with prompt "${prompt.replaceAll('"', '\\"')}")`,
        "POSIX path of theFolder",
      ];
      const out = execFileSync(
        "/usr/bin/osascript",
        applescriptParts.flatMap((line) => ["-e", line]),
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 10 * 60 * 1000,
        },
      );
      const dir = String(out ?? "")
        .trim()
        .replace(/\/$/, "");
      if (!dir) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no directory selected"));
        return;
      }
      respond(true, { ok: true, dir }, undefined);
    } catch (err: unknown) {
      // User cancel typically throws with exit code 1. Treat as ok+null so UI can ignore.
      const msg = String((err as { message?: unknown })?.message ?? err);
      if (msg.toLowerCase().includes("user canceled") || msg.toLowerCase().includes("cancel")) {
        respond(true, { ok: true, dir: null }, undefined);
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `failed to pick directory: ${msg}`),
      );
    }
  },
};
