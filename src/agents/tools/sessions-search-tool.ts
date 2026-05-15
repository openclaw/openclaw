import fs from "node:fs/promises";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeOptionalString, readStringValue } from "../../shared/string-coerce.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  describeSessionsSearchTool,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  ToolInputError,
} from "./common.js";
import type { SessionKind, SessionListRow } from "./sessions-helpers.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

const SessionsSearchToolSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  maxMatchesPerSession: Type.Optional(Type.Number({ minimum: 1 })),
  contextChars: Type.Optional(Type.Number({ minimum: 1 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  kinds: Type.Optional(Type.Array(Type.String())),
});

type GatewayCaller = typeof callGateway;

type SessionsListDetails = {
  sessions?: SessionListRow[];
};

type SearchMatch = {
  line: number;
  preview: string;
};

type SessionSearchResult = {
  sessionKey: string;
  sessionId?: string;
  label?: string;
  updatedAt?: number | null;
  matches: SearchMatch[];
};

type SkipReason = "missing_transcript" | "too_large" | "unreadable" | "timeout";

const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_LIMIT = 50;
const DEFAULT_MATCHES_PER_SESSION = 1;
const MAX_MATCHES_PER_SESSION = 5;
const DEFAULT_CONTEXT_CHARS = 160;
const MAX_CONTEXT_CHARS = 500;
const MAX_QUERY_CHARS = 256;
const MIN_QUERY_CHARS = 2;
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const SEARCH_BUDGET_MS = 5000;
const LIST_CANDIDATE_LIMIT = 200;

function readClampedInteger(params: {
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
}) {
  if (params.value === undefined) {
    return params.fallback;
  }
  return Math.min(params.max, Math.max(params.min, Math.floor(params.value)));
}

function readSearchQuery(params: Record<string, unknown>): string {
  const query = readStringParam(params, "query", { required: true, label: "query" });
  if (query.length < MIN_QUERY_CHARS) {
    throw new ToolInputError(`query must be at least ${MIN_QUERY_CHARS} characters`);
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new ToolInputError(`query must be at most ${MAX_QUERY_CHARS} characters`);
  }
  return query;
}

function readAllowedKinds(params: Record<string, unknown>): SessionKind[] | undefined {
  const values = readStringArrayParam(params, "kinds")
    ?.map((value) => value.trim().toLowerCase())
    .filter((value): value is SessionKind =>
      ["main", "group", "cron", "hook", "node", "other"].includes(value),
    );
  return values?.length ? values : undefined;
}

function readVisibleSessionsList(result: { details?: unknown }): SessionListRow[] {
  const details = result.details as SessionsListDetails | undefined;
  return Array.isArray(details?.sessions) ? details.sessions : [];
}

function addSkipped(skipped: Map<SkipReason, number>, reason: SkipReason): void {
  skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
}

function buildPreview(params: {
  line: string;
  index: number;
  queryLength: number;
  contextChars: number;
}): string {
  const start = Math.max(0, params.index - params.contextChars);
  const end = Math.min(params.line.length, params.index + params.queryLength + params.contextChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < params.line.length ? "..." : "";
  return `${prefix}${truncateUtf16Safe(params.line.slice(start, end).trim(), params.contextChars * 2 + params.queryLength)}${suffix}`;
}

async function searchTranscript(params: {
  transcriptPath: string;
  query: string;
  maxMatches: number;
  contextChars: number;
}): Promise<{ matches: SearchMatch[] } | { skipped: SkipReason }> {
  let stat;
  try {
    stat = await fs.stat(params.transcriptPath);
  } catch {
    return { skipped: "missing_transcript" };
  }
  if (!stat.isFile()) {
    return { skipped: "missing_transcript" };
  }
  if (stat.size > MAX_TRANSCRIPT_BYTES) {
    return { skipped: "too_large" };
  }

  let text: string;
  try {
    text = await fs.readFile(params.transcriptPath, "utf8");
  } catch {
    return { skipped: "unreadable" };
  }

  const needle = params.query.toLowerCase();
  const matches: SearchMatch[] = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const index = line.toLowerCase().indexOf(needle);
    if (index < 0) {
      continue;
    }
    matches.push({
      line: i + 1,
      preview: buildPreview({
        line,
        index,
        queryLength: params.query.length,
        contextChars: params.contextChars,
      }),
    });
    if (matches.length >= params.maxMatches) {
      break;
    }
  }
  return { matches };
}

export function createSessionsSearchTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Search",
    name: "sessions_search",
    displaySummary: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSearchTool(),
    parameters: SessionsSearchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const query = readSearchQuery(params);
      const resultLimit = readClampedInteger({
        value: readNumberParam(params, "limit"),
        fallback: DEFAULT_RESULT_LIMIT,
        min: 1,
        max: MAX_RESULT_LIMIT,
      });
      const maxMatchesPerSession = readClampedInteger({
        value: readNumberParam(params, "maxMatchesPerSession"),
        fallback: DEFAULT_MATCHES_PER_SESSION,
        min: 1,
        max: MAX_MATCHES_PER_SESSION,
      });
      const contextChars = readClampedInteger({
        value: readNumberParam(params, "contextChars"),
        fallback: DEFAULT_CONTEXT_CHARS,
        min: 40,
        max: MAX_CONTEXT_CHARS,
      });
      const activeMinutes = readNumberParam(params, "activeMinutes");
      const agentId = readStringParam(params, "agentId");
      const kinds = readAllowedKinds(params);
      const cfg = opts?.config ?? getRuntimeConfig();
      const gatewayCall = opts?.callGateway ?? callGateway;
      const sessionsListTool = createSessionsListTool({
        agentSessionKey: opts?.agentSessionKey,
        sandboxed: opts?.sandboxed,
        config: cfg,
        callGateway: gatewayCall,
      });
      const listResult = await sessionsListTool.execute("sessions-search-list", {
        ...(kinds ? { kinds } : {}),
        ...(agentId ? { agentId } : {}),
        ...(activeMinutes !== undefined ? { activeMinutes } : {}),
        limit: Math.max(LIST_CANDIDATE_LIMIT, resultLimit),
      });
      const sessions = readVisibleSessionsList(listResult);
      const skipped = new Map<SkipReason, number>();
      const matches: SessionSearchResult[] = [];
      const startedAt = Date.now();
      let partial = false;

      for (const session of sessions) {
        if (Date.now() - startedAt > SEARCH_BUDGET_MS) {
          partial = true;
          addSkipped(skipped, "timeout");
          break;
        }
        const transcriptPath = normalizeOptionalString(session.transcriptPath);
        if (!transcriptPath) {
          addSkipped(skipped, "missing_transcript");
          continue;
        }
        const result = await searchTranscript({
          transcriptPath,
          query,
          maxMatches: maxMatchesPerSession,
          contextChars,
        });
        if ("skipped" in result) {
          addSkipped(skipped, result.skipped);
          continue;
        }
        if (result.matches.length === 0) {
          continue;
        }
        const sessionId = readStringValue(session.sessionId);
        const label = readStringValue(session.label);
        matches.push({
          sessionKey: session.key,
          ...(sessionId ? { sessionId } : {}),
          ...(label ? { label } : {}),
          ...(typeof session.updatedAt === "number" ? { updatedAt: session.updatedAt } : {}),
          matches: result.matches,
        });
        if (matches.length >= resultLimit) {
          break;
        }
      }

      return jsonResult({
        query,
        searchedSessions: sessions.length,
        skippedSessions: Array.from(skipped.values()).reduce((sum, count) => sum + count, 0),
        partial,
        matches,
        skipped: Array.from(skipped.entries()).map(([reason, count]) => ({ reason, count })),
      });
    },
  };
}
