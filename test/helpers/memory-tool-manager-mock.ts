import { vi } from "vitest";
import type { MemorySearchResult } from "../../src/memory/types.js";

export type MemoryReadParams = {
  relPath: string;
  from?: number;
  lines?: number;
};

type SearchImpl = (
  query: string,
  opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
) => Promise<MemorySearchResult[]>;

type ReadFileImpl = (params: MemoryReadParams) => Promise<{ text: string; path: string }>;

let currentBackend: "builtin" | "qmd" = "builtin";
let currentSearchImpl: SearchImpl = async () => [];
let currentReadFileImpl: ReadFileImpl = async (params) => ({ text: "", path: params.relPath });

export function resetMemoryToolMockState(options: {
  backend?: "builtin" | "qmd";
  searchImpl?: SearchImpl;
  readFileImpl?: ReadFileImpl;
}): void {
  currentBackend = options.backend ?? "builtin";
  currentSearchImpl = options.searchImpl ?? (async () => []);
  currentReadFileImpl =
    options.readFileImpl ??
    (async (params: MemoryReadParams) => ({ text: "", path: params.relPath }));
}

export function setMemoryBackend(backend: "builtin" | "qmd"): void {
  currentBackend = backend;
}

export function setMemorySearchImpl(impl: SearchImpl): void {
  currentSearchImpl = impl;
}

export function setMemoryReadFileImpl(impl: ReadFileImpl): void {
  currentReadFileImpl = impl;
}

vi.mock("../../src/memory/index.js", () => ({
  getMemorySearchManager: async () => ({
    manager: {
      search: (
        query: string,
        opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
      ) => currentSearchImpl(query, opts),
      readFile: (params: MemoryReadParams) => currentReadFileImpl(params),
      status: () => ({
        backend: currentBackend,
        provider: "mock",
        model: "mock-embed",
      }),
      sync: async () => {},
      probeEmbeddingAvailability: async () => ({ ok: true }),
      probeVectorAvailability: async () => false,
    },
    error: undefined,
  }),
}));

vi.mock("../../src/memory/backend-config.js", () => ({
  resolveMemoryBackendConfig: (_params: {
    cfg?: {
      memory?: {
        qmd?: {
          limits?: {
            maxInjectedChars?: number;
            maxResults?: number;
            maxSnippetChars?: number;
            timeoutMs?: number;
          };
        };
      };
      citations?: string;
    };
    agentId?: string;
  }) => {
    const qmdLimits = _params?.cfg?.memory?.qmd?.limits;
    if (currentBackend === "qmd") {
      return {
        backend: "qmd",
        citations: "auto",
        qmd: {
          limits: {
            maxResults: qmdLimits?.maxResults ?? 6,
            maxSnippetChars: qmdLimits?.maxSnippetChars ?? 700,
            maxInjectedChars: qmdLimits?.maxInjectedChars ?? 4000,
            timeoutMs: qmdLimits?.timeoutMs ?? 4000,
          },
        },
      };
    }
    return {
      backend: currentBackend,
      citations: "auto",
    };
  },
}));
