import { parseFrontmatterBlock } from "../markdown/frontmatter.js";
import {
  getFrontmatterString,
  normalizeStringList,
  parseActiviManifestInstallBase,
  parseFrontmatterBool,
  resolveActiviManifestBlock,
  resolveActiviManifestInstall,
  resolveActiviManifestOs,
  resolveActiviManifestRequires,
} from "../shared/frontmatter.js";
import type {
  ActiviHookMetadata,
  HookEntry,
  HookInstallSpec,
  HookInvocationPolicy,
  ParsedHookFrontmatter,
} from "./types.js";

export function parseFrontmatter(content: string): ParsedHookFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseInstallSpec(input: unknown): HookInstallSpec | undefined {
  const parsed = parseActiviManifestInstallBase(input, ["bundled", "npm", "git"]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec: HookInstallSpec = {
    kind: parsed.kind as HookInstallSpec["kind"],
  };

  if (parsed.id) {
    spec.id = parsed.id;
  }
  if (parsed.label) {
    spec.label = parsed.label;
  }
  if (parsed.bins) {
    spec.bins = parsed.bins;
  }
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.repository === "string") {
    spec.repository = raw.repository;
  }

  return spec;
}

export function resolveActiviMetadata(
  frontmatter: ParsedHookFrontmatter,
): ActiviHookMetadata | undefined {
  const metadataObj = resolveActiviManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveActiviManifestRequires(metadataObj);
  const install = resolveActiviManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveActiviManifestOs(metadataObj);
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
