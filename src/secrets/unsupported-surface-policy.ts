import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { isRecord } from "../utils.js";

type ChannelUnsupportedSecretRefSurface = {
  unsupportedSecretRefSurfacePatterns?: readonly string[];
  collectUnsupportedSecretRefConfigCandidates?: (
    raw: unknown,
  ) => UnsupportedSecretRefConfigCandidate[];
};

const CORE_UNSUPPORTED_SECRETREF_SURFACE_PATTERNS = [
  "commands.ownerDisplaySecret",
  "hooks.token",
  "hooks.gmail.pushToken",
  "hooks.mappings[].sessionKey",
  "auth-profiles.oauth.*",
] as const;

type BundledChannelContractSurfacesModule = {
  getBundledChannelContractSurfaces?: () => unknown[];
};

const CONTRACT_SURFACES_MODULE_PATH = fileURLToPath(
  new URL("../channels/plugins/contract-surfaces.js", import.meta.url),
);
let bundledChannelContractSurfacesModule: BundledChannelContractSurfacesModule | null | undefined;
let bundledChannelContractSurfacesLoader: ReturnType<typeof createJiti> | undefined;

function loadBundledChannelContractSurfacesModule(): BundledChannelContractSurfacesModule | null {
  if (bundledChannelContractSurfacesModule !== undefined) {
    return bundledChannelContractSurfacesModule;
  }
  try {
    bundledChannelContractSurfacesLoader ??= createJiti(import.meta.url, { interopDefault: true });
    bundledChannelContractSurfacesModule = bundledChannelContractSurfacesLoader(
      CONTRACT_SURFACES_MODULE_PATH,
    ) as BundledChannelContractSurfacesModule;
  } catch {
    bundledChannelContractSurfacesModule = null;
  }
  return bundledChannelContractSurfacesModule;
}

function listChannelUnsupportedSecretRefSurfaces(): ChannelUnsupportedSecretRefSurface[] {
  const module = loadBundledChannelContractSurfacesModule();
  if (typeof module?.getBundledChannelContractSurfaces !== "function") {
    return [];
  }
  return module.getBundledChannelContractSurfaces() as ChannelUnsupportedSecretRefSurface[];
}

function collectChannelUnsupportedSecretRefSurfacePatterns(): string[] {
  return listChannelUnsupportedSecretRefSurfaces().flatMap(
    (surface) => surface.unsupportedSecretRefSurfacePatterns ?? [],
  );
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
    for (const surface of listChannelUnsupportedSecretRefSurfaces()) {
      const channelCandidates = surface.collectUnsupportedSecretRefConfigCandidates?.(raw);
      if (!channelCandidates?.length) {
        continue;
      }
      candidates.push(...channelCandidates);
    }
  }

  return candidates;
}
