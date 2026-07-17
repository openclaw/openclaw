import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type AnyAgentTool,
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SECRETS_PATH = `${homedir()}/.openclaw/secrets/immich.env`;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImmichSearchToolOptions = {
  config?: OpenClawConfig;
};

type ImmichClientConfig = {
  baseUrl: string;
  apiKey: string;
};

type ImmichPerson = {
  id: string;
  name: string;
  isHidden?: boolean;
};

type ImmichAsset = {
  id: string;
  originalPath?: string;
  originalFileName?: string;
  fileCreatedAt?: string;
  localDateTime?: string;
  type?: string;
};

type ImmichSearchResponse = {
  assets?: { items?: ImmichAsset[] };
  // Some legacy / fallback shapes return a flat array at the top.
  items?: ImmichAsset[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadImmichConfig(path: string): Promise<ImmichClientConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolInputError(`immich_search: cannot read secrets file ${path} (${msg})`);
  }
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      const key = m[1] as string;
      const val = (m[2] as string).trim().replace(/^["']|["']$/g, "");
      env[key] = val;
    }
  }
  const apiKey = env.IMMICH_API_KEY;
  const baseUrl = env.IMMICH_BASE_URL || "http://127.0.0.1:2283";
  if (!apiKey) {
    throw new ToolInputError(`immich_search: IMMICH_API_KEY missing in ${path}`);
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function callImmichApi<T = unknown>(
  cfg: ImmichClientConfig,
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
  timeoutMs: number,
): Promise<T> {
  const url = `${cfg.baseUrl}${path}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "x-api-key": cfg.apiKey,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const init: RequestInit = {
      method,
      headers,
      signal: ctrl.signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Immich API ${method} ${path} -> HTTP ${res.status}${text ? ": " + text.slice(0, 300) : ""}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(tid);
  }
}

function extractAssets(r: ImmichSearchResponse): ImmichAsset[] {
  if (r.assets && Array.isArray(r.assets.items)) {
    return r.assets.items;
  }
  if (Array.isArray(r.items)) {
    return r.items;
  }
  return [];
}

function summarizeAsset(a: ImmichAsset) {
  return {
    asset_id: a.id,
    path: a.originalPath,
    file_name: a.originalFileName,
    taken_at: a.fileCreatedAt ?? a.localDateTime,
    kind: a.type,
  };
}

function resolveToolRuntime(options: ImmichSearchToolOptions) {
  const cfg = options.config?.tools?.immich?.search;
  return {
    secretsPath: cfg?.secretsFile ?? DEFAULT_SECRETS_PATH,
    timeoutMs:
      typeof cfg?.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs)
        ? Math.max(500, Math.min(60_000, Math.floor(cfg.timeoutMs)))
        : DEFAULT_TIMEOUT_MS,
  };
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BY_FACE_SCHEMA = {
  type: "object",
  required: ["person"],
  properties: {
    person: {
      type: "string",
      description:
        "Name (or part of name) of the labelled person in Immich. Case-insensitive substring match. Person must already be named on the People page in the Immich Web UI.",
    },
    limit: {
      type: "number",
      description: "Maximum assets to return (default 10, max 100).",
      minimum: 1,
      maximum: MAX_LIMIT,
    },
  },
} satisfies Record<string, unknown>;

const SMART_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language description of what the photo shows (CLIP). Examples: 'sunset on a beach', 'dog playing in snow', 'รูปทะเล', 'cake with candles'. Works in English and Thai.",
    },
    limit: {
      type: "number",
      description: "Maximum assets to return (default 10, max 100).",
      minimum: 1,
      maximum: MAX_LIMIT,
    },
  },
} satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tool: immich_search_by_face
// ---------------------------------------------------------------------------

export function createImmichSearchByFaceTool(
  options: ImmichSearchToolOptions,
): AnyAgentTool | null {
  if (options.config?.tools?.immich?.search?.enabled === false) {
    return null;
  }
  const { secretsPath, timeoutMs } = resolveToolRuntime(options);

  return {
    label: "Immich Search by Face",
    name: "immich_search_by_face",
    description:
      "Find photos of a specific labelled person via Immich's face-recognition database. The person must already be named on Immich's People page (e.g. 'Lois', 'Lynn', 'Gee', 'Nook'). Returns asset paths under /mnt/qnap/Multimedia/... ; pipe each path into telegram_send_photo to deliver the file. Use this when the user asks for photos of a SPECIFIC named person.",
    parameters: BY_FACE_SCHEMA,
    ownerOnly: true,
    execute: async (_toolCallId, args, _signal) => {
      const params = asToolParamsRecord(args);
      const personName = readStringParam(params, "person", { required: true, label: "person" });
      const limit = clampLimit(readNumberParam(params, "limit"));

      const cfg = await loadImmichConfig(secretsPath);

      // Step 1: lookup matching person by name.
      const peopleResp = await callImmichApi<{ people?: ImmichPerson[] }>(
        cfg,
        "GET",
        "/api/people?withHidden=false",
        undefined,
        timeoutMs,
      );
      const haystack = (peopleResp.people ?? []).filter(
        (p): p is ImmichPerson => Boolean(p && p.name) && p.isHidden !== true,
      );
      const needle = personName.toLowerCase();
      const matches = haystack.filter((p) => p.name.toLowerCase().includes(needle));
      if (matches.length === 0) {
        return jsonResult({
          ok: false,
          error: "person_not_found",
          query: personName,
          hint: "Make sure the person is named on Immich's People page first. Available named people listed below.",
          available_people: haystack.slice(0, 50).map((p) => p.name),
        });
      }
      const exact = matches.find((p) => p.name.toLowerCase() === needle);
      const person = exact ?? (matches[0] as ImmichPerson);

      // Step 2: search assets with that person.
      const search = await callImmichApi<ImmichSearchResponse>(
        cfg,
        "POST",
        "/api/search/metadata",
        {
          personIds: [person.id],
          size: limit,
          page: 1,
          order: "desc",
        },
        timeoutMs,
      );

      const assets = extractAssets(search).slice(0, limit).map(summarizeAsset);
      return jsonResult({
        ok: true,
        person: { id: person.id, name: person.name },
        count: assets.length,
        next_step_hint:
          assets.length > 0
            ? "Pick one path and call telegram_send_photo with file_path = path."
            : "No assets returned. Facial Recognition may still be processing this person.",
        assets,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: immich_search_smart
// ---------------------------------------------------------------------------

export function createImmichSearchSmartTool(options: ImmichSearchToolOptions): AnyAgentTool | null {
  if (options.config?.tools?.immich?.search?.enabled === false) {
    return null;
  }
  const { secretsPath, timeoutMs } = resolveToolRuntime(options);

  return {
    label: "Immich Smart Search",
    name: "immich_search_smart",
    description:
      "Search photos by natural-language description (CLIP semantic search via Immich). Examples: 'sunset on a beach', 'dog playing in snow', 'รูปทะเล', 'cake with candles'. Returns asset paths under /mnt/qnap/Multimedia/... ; pipe each path into telegram_send_photo to deliver. Use this for content-based queries (what the photo shows). For a SPECIFIC named person use immich_search_by_face instead.",
    parameters: SMART_SCHEMA,
    ownerOnly: true,
    execute: async (_toolCallId, args, _signal) => {
      const params = asToolParamsRecord(args);
      const query = readStringParam(params, "query", { required: true, label: "query" });
      const limit = clampLimit(readNumberParam(params, "limit"));

      const cfg = await loadImmichConfig(secretsPath);

      const search = await callImmichApi<ImmichSearchResponse>(
        cfg,
        "POST",
        "/api/search/smart",
        {
          query,
          size: limit,
          page: 1,
        },
        timeoutMs,
      );

      const assets = extractAssets(search).slice(0, limit).map(summarizeAsset);
      return jsonResult({
        ok: true,
        query,
        count: assets.length,
        next_step_hint:
          assets.length > 0
            ? "Pick one path and call telegram_send_photo with file_path = path."
            : "No assets matched. Smart Search may still be indexing — try again in a few minutes.",
        assets,
      });
    },
  };
}
