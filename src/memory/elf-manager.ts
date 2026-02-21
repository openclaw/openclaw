import type { ResolvedElfConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory");

type ElfSearchItem = {
  note_id?: string;
  type?: string;
  key?: string | null;
  scope?: string;
  updated_at?: string;
  expires_at?: string | null;
  final_score?: number;
  summary?: string;
};

type ElfSearchResponse = {
  search_id?: string;
  items?: ElfSearchItem[];
};

type ElfNoteResponse = {
  note_id?: string;
  text?: string;
};

function joinUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.trim();
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  const nextPath = pathname.replace(/^\/+/, "");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${nextPath}`;
  return url.toString();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function fetchJson<T>(params: {
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), params.timeoutMs);
  try {
    const res = await fetch(params.url, { ...params.init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function toInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function buildHeaders(cfg: ResolvedElfConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-ELF-Tenant-Id": cfg.tenantId,
    "X-ELF-Project-Id": cfg.projectId,
    "X-ELF-Agent-Id": cfg.agentId,
  };
  if (cfg.authToken) {
    headers.Authorization = `Bearer ${cfg.authToken}`;
  }
  return headers;
}

function parseError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function formatSnippet(item: ElfSearchItem): string {
  const summary = item.summary?.trim() ?? "";
  const type = item.type?.trim();
  const scope = item.scope?.trim();
  const key = item.key?.trim() ?? null;
  const parts = [
    type ? `type=${type}` : null,
    scope ? `scope=${scope}` : null,
    key ? `key=${key}` : null,
  ].filter(Boolean);
  if (parts.length === 0) {
    return summary;
  }
  return summary ? `${summary}\n\n(${parts.join(", ")})` : `(${parts.join(", ")})`;
}

export class ElfMemoryManager implements MemorySearchManager {
  static async create(params: { resolved: ResolvedElfConfig }): Promise<ElfMemoryManager> {
    return new ElfMemoryManager(params.resolved);
  }

  private readonly cfg: ResolvedElfConfig;

  private constructor(cfg: ResolvedElfConfig) {
    this.cfg = cfg;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const topK = toInt(opts?.maxResults ?? this.cfg.topK, 12);
    const candidateK = toInt(this.cfg.candidateK, 60);
    const body = JSON.stringify({ query, top_k: topK, candidate_k: candidateK });
    const url = joinUrl(this.cfg.baseUrl, "/v2/searches");
    const headers = {
      ...buildHeaders(this.cfg),
      "X-ELF-Read-Profile": this.cfg.readProfile,
    };

    const payload = await fetchJson<ElfSearchResponse>({
      url,
      init: { method: "POST", headers, body },
      timeoutMs: this.cfg.timeoutMs,
    });

    const items = Array.isArray(payload.items) ? payload.items : [];
    const minScore = typeof opts?.minScore === "number" ? opts.minScore : undefined;
    const results: MemorySearchResult[] = [];
    for (const item of items) {
      const noteId = item.note_id?.trim();
      if (!noteId || !isUuid(noteId)) {
        continue;
      }
      const score = typeof item.final_score === "number" ? item.final_score : 0;
      if (typeof minScore === "number" && score < minScore) {
        continue;
      }
      const snippet = formatSnippet(item);
      const endLine = Math.max(1, snippet.split("\n").length);
      results.push({
        path: `elf/${noteId}`,
        startLine: 1,
        endLine,
        score,
        snippet,
        source: "memory",
      });
      if (results.length >= topK) {
        break;
      }
    }
    return results;
  }

  async readFile(params: {
    relPath: string;
    from?: number | undefined;
    lines?: number | undefined;
  }): Promise<{ text: string; path: string }> {
    const relPath = params.relPath.trim();
    if (!relPath.startsWith("elf/")) {
      throw new Error("unsupported path (expected elf/<note_id>)");
    }
    const noteId = relPath.slice("elf/".length).trim();
    if (!isUuid(noteId)) {
      throw new Error("invalid ELF note id");
    }
    const url = joinUrl(this.cfg.baseUrl, `/v2/notes/${noteId}`);
    const headers = buildHeaders(this.cfg);
    const payload = await fetchJson<ElfNoteResponse>({
      url,
      init: { method: "GET", headers },
      timeoutMs: this.cfg.timeoutMs,
    });
    const fullText = payload.text ?? "";
    if (typeof fullText !== "string") {
      return { path: relPath, text: "" };
    }
    const allLines = fullText.split("\n");
    const from = typeof params.from === "number" ? Math.max(1, Math.floor(params.from)) : 1;
    const lines = typeof params.lines === "number" ? Math.max(1, Math.floor(params.lines)) : 200;
    const slice = allLines.slice(from - 1, from - 1 + lines).join("\n");
    return { path: relPath, text: slice };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "elf",
      provider: "elf",
      model: undefined,
      requestedProvider: "elf",
      sources: ["memory"],
      custom: {
        elf: {
          baseUrl: this.cfg.baseUrl,
          tenantId: this.cfg.tenantId,
          projectId: this.cfg.projectId,
          agentId: this.cfg.agentId,
          readProfile: this.cfg.readProfile,
        },
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      await this.probeHealth();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: parseError(err) };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      await this.probeHealth();
      return true;
    } catch (err) {
      log.warn(`elf health probe failed: ${parseError(err)}`);
      return false;
    }
  }

  private async probeHealth(): Promise<void> {
    const url = joinUrl(this.cfg.baseUrl, "/health");
    await fetchJson<unknown>({
      url,
      init: { method: "GET" },
      timeoutMs: this.cfg.timeoutMs,
    });
  }
}
