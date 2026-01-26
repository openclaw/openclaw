import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { loadSessionEntry } from "../../gateway/session-utils.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
} from "./sessions-helpers.js";

const SessionsTagsToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  add: Type.Optional(Type.Array(Type.String())),
  remove: Type.Optional(Type.Array(Type.String())),
  clear: Type.Optional(Type.Boolean()),
});

function normalizeTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().replace(/\s+/g, " ");
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 64) break;
  }
  return out;
}

export function createSessionsTagsTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Tags",
    name: "sessions_tags",
    description:
      "Set/add/remove tags on a session for filtering/slicing in the Sessions UI. Default: current session.",
    parameters: SessionsTagsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const visibility = cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : undefined;
      const restrictToSpawned =
        opts?.sandboxed === true &&
        visibility === "spawned" &&
        !!requesterInternalKey &&
        !isSubagentSessionKey(requesterInternalKey);

      const sessionKeyParam =
        readStringParam(params, "sessionKey")?.trim() || opts?.agentSessionKey?.trim();
      if (!sessionKeyParam) {
        return jsonResult({ ok: false, error: "sessionKey required" });
      }

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          ok: false,
          error: resolvedSession.error,
          status: resolvedSession.status,
        });
      }

      const target = loadSessionEntry(resolvedSession.key);
      const canonicalKey = target.canonicalKey;

      const requesterAgentId = resolveAgentIdFromSessionKey(requesterInternalKey);
      const targetAgentId = resolveAgentIdFromSessionKey(canonicalKey);
      if (requesterAgentId !== targetAgentId) {
        if (!a2aPolicy.enabled) {
          return jsonResult({
            ok: false,
            status: "forbidden",
            error:
              "Cross-agent access is disabled. Set tools.agentToAgent.enabled=true and allow both agent IDs.",
          });
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          return jsonResult({
            ok: false,
            status: "forbidden",
            error: "Cross-agent access denied by tools.agentToAgent.allow.",
          });
        }
      }

      if (restrictToSpawned && !resolvedSession.resolvedViaSessionId) {
        const sessions = (await callGateway({
          method: "sessions.list",
          params: {
            includeGlobal: false,
            includeUnknown: false,
            limit: 500,
            spawnedBy: requesterInternalKey,
          },
          timeoutMs: 10_000,
        })) as { sessions?: Array<Record<string, unknown>> };
        const ok = (Array.isArray(sessions?.sessions) ? sessions.sessions : []).some(
          (entry) => entry?.key === canonicalKey,
        );
        if (!ok) {
          return jsonResult({
            ok: false,
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${resolvedSession.displayKey}`,
            sessionKey: resolvedSession.displayKey,
          });
        }
      }

      const clear = params.clear === true;
      const tagsParam = "tags" in params ? normalizeTagList(params.tags) : undefined;
      const addParam = readStringArrayParam(params, "add");
      const removeParam = readStringArrayParam(params, "remove");

      if (clear && (tagsParam !== undefined || addParam?.length || removeParam?.length)) {
        return jsonResult({ ok: false, error: "clear cannot be combined with tags/add/remove" });
      }
      if (tagsParam !== undefined && (addParam?.length || removeParam?.length)) {
        return jsonResult({ ok: false, error: "tags cannot be combined with add/remove" });
      }

      let nextTags: string[] | null | undefined;
      if (clear) {
        nextTags = null;
      } else if (tagsParam !== undefined) {
        nextTags = tagsParam.length ? tagsParam : null;
      } else if (addParam?.length || removeParam?.length) {
        const current = normalizeTagList(target.entry?.tags);

        const removeSet = new Set(normalizeTagList(removeParam ?? []).map((t) => t.toLowerCase()));
        const base = current.filter((t) => !removeSet.has(t.toLowerCase()));
        const additions = normalizeTagList(addParam ?? []);
        const baseSet = new Set(base.map((t) => t.toLowerCase()));
        for (const tag of additions) {
          const key = tag.toLowerCase();
          if (baseSet.has(key)) continue;
          baseSet.add(key);
          base.push(tag);
        }
        nextTags = base.length ? base : null;
      } else {
        return jsonResult({ ok: false, error: "Provide one of: tags, add/remove, or clear" });
      }

      const patched = (await callGateway({
        method: "sessions.patch",
        params: {
          key: canonicalKey,
          tags: nextTags,
        },
        timeoutMs: 10_000,
      })) as { ok?: boolean; key?: string; entry?: { tags?: unknown } };

      const updatedTags = normalizeTagList(patched?.entry?.tags);
      return jsonResult({
        ok: true,
        sessionKey: resolvedSession.displayKey,
        tags: updatedTags,
      });
    },
  };
}
