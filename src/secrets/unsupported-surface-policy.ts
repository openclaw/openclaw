import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";
import { loadBundledChannelSecurityContractApi } from "./channel-contract-api.js";

const CORE_UNSUPPORTED_SECRETREF_SURFACE_PATTERNS = [
  "commands.ownerDisplaySecret",
  "hooks.token",
  "hooks.gmail.pushToken",
  "hooks.mappings[].sessionKey",
  "auth-profiles.oauth.*",
] as const;

function listBundledChannelIds(): string[] {
  return [
    ...new Set(
      loadPluginManifestRegistry({})
        .plugins.filter((entry) => entry.origin === "bundled")
        .flatMap((entry) => entry.channels),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function collectChannelUnsupportedSecretRefSurfacePatterns(): string[] {
  const patterns: string[] = [];
  for (const channelId of listBundledChannelIds()) {
    const contract = loadBundledChannelSecurityContractApi(channelId);
    patterns.push(...(contract?.unsupportedSecretRefSurfacePatterns ?? []));
  }
  return patterns;
}

let cachedUnsupportedSecretRefSurfacePatterns: string[] | null = null;

export function getUnsupportedSecretRefSurfacePatterns(): string[] {
  cachedUnsupportedSecretRefSurfacePatterns ??= [
    ...CORE_UNSUPPORTED_SECRETREF_SURFACE_PATTERNS,
    ...collectChannelUnsupportedSecretRefSurfacePatterns(),
  ];
  return cachedUnsupportedSecretRefSurfacePatterns;
}

export type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

export function collectUnsupportedSecretRefConfigCandidates(
  raw: unknown,
): UnsupportedSecretRefConfigCandidate[] {
  if (!isRecord(raw)) {
    return [];
  }

  const candidates: UnsupportedSecretRefConfigCandidate[] = [];

  const commands = isRecord(raw.commands) ? raw.commands : null;
  if (commands) {
    candidates.push({
      path: "commands.ownerDisplaySecret",
      value: commands.ownerDisplaySecret,
    });
  }

  const hooks = isRecord(raw.hooks) ? raw.hooks : null;
  if (hooks) {
    candidates.push({ path: "hooks.token", value: hooks.token });

    const gmail = isRecord(hooks.gmail) ? hooks.gmail : null;
    if (gmail) {
      candidates.push({
        path: "hooks.gmail.pushToken",
        value: gmail.pushToken,
      });
    }

    const mappings = hooks.mappings;
    if (Array.isArray(mappings)) {
      for (const [index, mapping] of mappings.entries()) {
        if (!isRecord(mapping)) {
          continue;
        }
        candidates.push({
          path: `hooks.mappings.${index}.sessionKey`,
          value: mapping.sessionKey,
        });
      }
    }
  }

  if (isRecord(raw.channels)) {
    for (const channelId of Object.keys(raw.channels)) {
      const contract = loadBundledChannelSecurityContractApi(channelId);
      const channelCandidates = contract?.collectUnsupportedSecretRefConfigCandidates?.(raw);
      if (!channelCandidates?.length) {
        continue;
      }
      candidates.push(...channelCandidates);
    }
  }

  return candidates;
}
