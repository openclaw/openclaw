import { Type } from "@sinclair/typebox";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { createArtifactRegistry, type ArtifactMeta } from "../../artifacts/artifact-registry.js";
import { resolveStateDir } from "../../config/paths.js";
import { jsonResult, readStringParam } from "./common.js";

const DEFAULT_MAX_CHARS = 8000;

const ArtifactsGetSchema = Type.Object({
  id: Type.String({
    description: "Artifact id (sha256 hex, 64 chars).",
  }),
});

function isSha256Hex(id: string): boolean {
  return /^[a-f0-9]{64}$/.test(id);
}

function truncateContent(params: { content: string; maxChars: number }): {
  content: string;
  truncated: boolean;
  originalChars: number;
} {
  const originalChars = params.content.length;
  const maxChars = Math.max(1, Math.floor(params.maxChars));
  if (originalChars <= maxChars) {
    return { content: params.content, truncated: false, originalChars };
  }
  return {
    content: params.content.slice(0, maxChars),
    truncated: true,
    originalChars,
  };
}

function resolveArtifactsDir(cfg?: OpenClawConfig): string {
  // Today artifacts are stored under stateDir/artifacts (same as bootstrap ArtifactRef storage).
  // Keep this derived from resolveStateDir so it respects OPENCLAW_STATE_DIR overrides.
  void cfg;
  return path.join(resolveStateDir(process.env), "artifacts");
}

export function createArtifactsGetTool(options?: { config?: OpenClawConfig }): AnyAgentTool {
  const registry = createArtifactRegistry({ rootDir: resolveArtifactsDir(options?.config) });

  return {
    name: "artifacts.get",
    description:
      "Fetch a stored artifact by id (sha256). Returns metadata and bounded content text.",
    parameters: ArtifactsGetSchema,
    async execute(_callId, rawParams) {
      const params = (rawParams ?? {}) as Record<string, unknown>;
      const id = readStringParam(params, "id", { required: true, label: "id" });
      if (!isSha256Hex(id)) {
        throw new Error("id must be a 64-char lowercase hex sha256");
      }

      const stored = await registry.get(id);
      const meta: ArtifactMeta = stored.meta;
      const truncated = truncateContent({ content: stored.content, maxChars: DEFAULT_MAX_CHARS });

      const payload = {
        meta,
        content: truncated.content,
        truncated: truncated.truncated,
        maxChars: DEFAULT_MAX_CHARS,
        ...(truncated.truncated ? { originalChars: truncated.originalChars } : null),
        ...(truncated.truncated
          ? {
              note: `Content truncated to ${DEFAULT_MAX_CHARS} chars.`,
            }
          : null),
      };

      return jsonResult(payload);
    },
  };
}

export const __testing = {
  isSha256Hex,
  truncateContent,
  DEFAULT_MAX_CHARS,
};
