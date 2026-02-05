import crypto from "node:crypto";
import type { MemoryContentObject } from "../types.js";

export type EnrichWarning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type EnrichHooks = {
  dedupe?: (episodes: MemoryContentObject[]) => {
    episodes: MemoryContentObject[];
    warnings: EnrichWarning[];
  };
  coreference?: (episodes: MemoryContentObject[]) => {
    episodes: MemoryContentObject[];
    warnings: EnrichWarning[];
  };
};

function normalizeTextKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function defaultDedupe(episodes: MemoryContentObject[]): {
  episodes: MemoryContentObject[];
  warnings: EnrichWarning[];
} {
  const warnings: EnrichWarning[] = [];
  const seen = new Map<string, MemoryContentObject>();
  const deduped: MemoryContentObject[] = [];

  for (const episode of episodes) {
    const text = episode.text ?? "";
    const key = `${normalizeTextKey(text)}|${episode.provenance?.source ?? ""}`;
    const existing = seen.get(key);
    if (existing) {
      warnings.push({
        code: "enrich.dedupe",
        message: "Duplicate episode suppressed during ingestion.",
        details: {
          keptId: existing.id,
          droppedId: episode.id,
        },
      });
      continue;
    }
    seen.set(key, episode);
    deduped.push(episode);
  }

  return { episodes: deduped, warnings };
}

function defaultCoreference(episodes: MemoryContentObject[]): {
  episodes: MemoryContentObject[];
  warnings: EnrichWarning[];
} {
  const warnings: EnrichWarning[] = [];
  const updated = episodes.map((episode) => {
    const metadata = episode.metadata;
    const coref = metadata?.coreferences;
    if (!coref || typeof coref !== "object") {
      return episode;
    }

    const aliasMap = (coref as Record<string, unknown>).aliases;
    if (!aliasMap || typeof aliasMap !== "object") {
      return episode;
    }

    let text = episode.text ?? "";
    for (const [alias, canonical] of Object.entries(aliasMap)) {
      if (typeof canonical !== "string" || canonical.length === 0) continue;
      const pattern = new RegExp(`\\b${alias}\\b`, "gi");
      text = text.replace(pattern, canonical);
    }

    if (text !== episode.text) {
      warnings.push({
        code: "enrich.coreference",
        message: "Co-reference aliases were normalized.",
        details: { id: episode.id },
      });

      return {
        ...episode,
        id: `${episode.id}:${crypto.randomUUID()}`,
        text,
      };
    }

    return episode;
  });

  return { episodes: updated, warnings };
}

export function enrichEpisodes(
  episodes: MemoryContentObject[],
  hooks: EnrichHooks = {},
): { episodes: MemoryContentObject[]; warnings: EnrichWarning[] } {
  const warnings: EnrichWarning[] = [];

  const corefHook = hooks.coreference ?? defaultCoreference;
  const corefResult = corefHook(episodes);
  warnings.push(...corefResult.warnings);

  const dedupeHook = hooks.dedupe ?? defaultDedupe;
  const dedupeResult = dedupeHook(corefResult.episodes);
  warnings.push(...dedupeResult.warnings);

  return { episodes: dedupeResult.episodes, warnings };
}
