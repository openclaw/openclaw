import { parseFrontmatterBlock } from "../markdown/frontmatter.js";
import {
  applyMullusiManifestInstallCommonFields,
  getFrontmatterString,
  normalizeStringList,
  parseMullusiManifestInstallBase,
  parseFrontmatterBool,
  resolveMullusiManifestBlock,
  resolveMullusiManifestInstall,
  resolveMullusiManifestOs,
  resolveMullusiManifestRequires,
} from "../shared/frontmatter.js";
import type {
  MullusiHookMetadata,
  HookEntry,
  HookInstallSpec,
  HookInvocationPolicy,
  ParsedHookFrontmatter,
} from "./types.js";

export function parseFrontmatter(content: string): ParsedHookFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseInstallSpec(input: unknown): HookInstallSpec | undefined {
  const parsed = parseMullusiManifestInstallBase(input, ["bundled", "npm", "git"]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec = applyMullusiManifestInstallCommonFields<HookInstallSpec>(
    {
      kind: parsed.kind as HookInstallSpec["kind"],
    },
    parsed,
  );
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.repository === "string") {
    spec.repository = raw.repository;
  }

  return spec;
}

export function resolveMullusiMetadata(
  frontmatter: ParsedHookFrontmatter,
): MullusiHookMetadata | undefined {
  const metadataObj = resolveMullusiManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveMullusiManifestRequires(metadataObj);
  const install = resolveMullusiManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveMullusiManifestOs(metadataObj);
  const eventsRaw = normalizeStringList(metadataObj.events);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : undefined,
    homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : undefined,
    hookKey: typeof metadataObj.hookKey === "string" ? metadataObj.hookKey : undefined,
    export: typeof metadataObj.export === "string" ? metadataObj.export : undefined,
    os: osRaw.length > 0 ? osRaw : undefined,
    events: eventsRaw.length > 0 ? eventsRaw : [],
    requires: requires,
    install: install.length > 0 ? install : undefined,
  };
}

export function resolveHookInvocationPolicy(
  frontmatter: ParsedHookFrontmatter,
): HookInvocationPolicy {
  return {
    enabled: parseFrontmatterBool(getFrontmatterString(frontmatter, "enabled"), true),
  };
}

export function resolveHookKey(hookName: string, entry?: HookEntry): string {
  return entry?.metadata?.hookKey ?? hookName;
}
