import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES } from "../plugins/public-artifacts.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const ALLOWED_EXTENSION_PUBLIC_SURFACES = new Set(GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES);
ALLOWED_EXTENSION_PUBLIC_SURFACES.add("test-api.js");
const GUARDED_CHANNEL_EXTENSIONS = new Set([
  "bluebubbles",
  "discord",
  "feishu",
  "googlechat",
  "imessage",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "msteams",
  "nostr",
  "nextcloud-talk",
  "signal",
  "slack",
  "synology-chat",
  "telegram",
  "tlon",
  "twitch",
  "whatsapp",
  "zalo",
  "zalouser",
]);

type GuardedSource = {
  path: string;
  forbiddenPatterns: RegExp[];
};

const SAME_CHANNEL_SDK_GUARDS: GuardedSource[] = [
  {
    path: "extensions/discord/src/shared.ts",
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/discord["']/, /plugin-sdk-internal\/discord/],
  },
  {
    path: "extensions/slack/src/shared.ts",
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/slack["']/, /plugin-sdk-internal\/slack/],
  },
  {
    path: "extensions/telegram/src/shared.ts",
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/telegram["']/, /plugin-sdk-internal\/telegram/],
  },
  {
    path: "extensions/imessage/src/shared.ts",
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/imessage["']/, /plugin-sdk-internal\/imessage/],
  },
  {
    path: "extensions/whatsapp/src/shared.ts",
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/whatsapp["']/, /plugin-sdk-internal\/whatsapp/],
  },
  {
    path: "extensions/signal/src/shared.ts",
    forbiddenPatterns: [/["']openclaw\/plugin-sdk\/signal["']/, /plugin-sdk-internal\/signal/],
  },
];

const SETUP_BARREL_GUARDS: GuardedSource[] = [
  {
    path: "extensions/signal/src/setup-core.ts",
    forbiddenPatterns: [/\bformatCliCommand\b/, /\bformatDocsLink\b/],
  },
  {
    path: "extensions/signal/src/setup-surface.ts",
    forbiddenPatterns: [
      /\bdetectBinary\b/,
      /\binstallSignalCli\b/,
      /\bformatCliCommand\b/,
      /\bformatDocsLink\b/,
    ],
  },
  {
    path: "extensions/slack/src/setup-core.ts",
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: "extensions/slack/src/setup-surface.ts",
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: "extensions/discord/src/setup-core.ts",
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: "extensions/discord/src/setup-surface.ts",
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: "extensions/imessage/src/setup-core.ts",
    forbiddenPatterns: [/\bformatDocsLink\b/],
  },
  {
    path: "extensions/imessage/src/setup-surface.ts",
    forbiddenPatterns: [/\bdetectBinary\b/, /\bformatDocsLink\b/],
  },
  {
    path: "extensions/telegram/src/setup-core.ts",
    forbiddenPatterns: [/\bformatCliCommand\b/, /\bformatDocsLink\b/],
  },
  {
    path: "extensions/whatsapp/src/setup-surface.ts",
    forbiddenPatterns: [/\bformatCliCommand\b/, /\bformatDocsLink\b/],
  },
];

const LOCAL_EXTENSION_API_BARREL_GUARDS = [
  "acpx",
  "bluebubbles",
  "device-pair",
  "diagnostics-otel",
  "discord",
  "diffs",
  "feishu",
  "google",
  "irc",
  "llm-task",
  "line",
  "lobster",
  "matrix",
  "mattermost",
  "memory-lancedb",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "open-prose",
  "phone-control",
  "copilot-proxy",
  "zai",
  "signal",
  "synology-chat",
  "talk-voice",
  "telegram",
  "thread-ownership",
  "tlon",
  "voice-call",
  "whatsapp",
  "twitch",
  "zalo",
  "zalouser",
] as const;

const LOCAL_EXTENSION_API_BARREL_EXCEPTIONS = [
  // Direct import avoids a circular init path:
  // accounts.ts -> runtime-api.ts -> src/plugin-sdk/matrix -> extensions/matrix/api.ts -> accounts.ts
  "extensions/matrix/src/matrix/accounts.ts",
] as const;

const sourceTextCache = new Map<string, string>();
type SourceAnalysis = {
  text: string;
  importSpecifiers: string[];
  extensionImports: string[];
};
const sourceAnalysisCache = new Map<string, SourceAnalysis>();
let extensionSourceFilesCache: string[] | null = null;
let coreSourceFilesCache: string[] | null = null;
const extensionFilesCache = new Map<string, string[]>();

type SourceFileCollectorOptions = {
  rootDir: string;
  shouldSkipPath?: (normalizedFullPath: string) => boolean;
  shouldSkipEntry?: (params: { entryName: string; normalizedFullPath: string }) => boolean;
};

function readSource(path: string): string {
  const fullPath = resolve(REPO_ROOT, path);
  const cached = sourceTextCache.get(fullPath);
  if (cached !== undefined) {
    return cached;
  }
  const text = readFileSync(fullPath, "utf8");
  sourceTextCache.set(fullPath, text);
  return text;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function collectSourceFiles(
  cached: string[] | undefined | null,
  options: SourceFileCollectorOptions,
): string[] {
  if (cached) {
    return cached;
  }
  const files: string[] = [];
  const stack = [options.rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      const normalizedFullPath = normalizePath(fullPath);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        if (options.shouldSkipPath?.(normalizedFullPath)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(entry.name)) {
        continue;
      }
      if (entry.name.endsWith(".d.ts")) {
        continue;
      }
      if (
        options.shouldSkipPath?.(normalizedFullPath) ||
        options.shouldSkipEntry?.({ entryName: entry.name, normalizedFullPath })
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

function readSetupBarrelImportBlock(path: string): string {
  const lines = readSource(path).split("\n");
  const targetLineIndex = lines.findIndex((line) =>
    /from\s*"[^"]*plugin-sdk(?:-internal)?\/setup(?:\.js)?";/.test(line),
  );
  if (targetLineIndex === -1) {
    return "";
  }
  let startLineIndex = targetLineIndex;
  while (startLineIndex >= 0 && !lines[startLineIndex].includes("import")) {
    startLineIndex -= 1;
  }
  return lines.slice(startLineIndex, targetLineIndex + 1).join("\n");
}

function collectExtensionSourceFiles(): string[] {
  const extensionsDir = normalizePath(resolve(ROOT_DIR, "..", "extensions"));
  const sharedExtensionsDir = normalizePath(resolve(extensionsDir, "shared"));
  extensionSourceFilesCache = collectSourceFiles(extensionSourceFilesCache, {
    rootDir: resolve(ROOT_DIR, "..", "extensions"),
    shouldSkipPath: (normalizedFullPath) =>
      normalizedFullPath.includes(sharedExtensionsDir) ||
      normalizedFullPath.includes(`${extensionsDir}/shared/`),
    shouldSkipEntry: ({ entryName, normalizedFullPath }) =>
      normalizedFullPath.includes(".test.") ||
      normalizedFullPath.includes(".test-") ||
      normalizedFullPath.includes(".fixture.") ||
      normalizedFullPath.includes(".snap") ||
      normalizedFullPath.includes("test-support") ||
      entryName === "api.ts" ||
      entryName === "runtime-api.ts",
  });
  return extensionSourceFilesCache;
}

function collectCoreSourceFiles(): string[] {
  const srcDir = resolve(ROOT_DIR, "..", "src");
  const normalizedPluginSdkDir = normalizePath(resolve(ROOT_DIR, "plugin-sdk"));
  coreSourceFilesCache = collectSourceFiles(coreSourceFilesCache, {
    rootDir: srcDir,
    shouldSkipEntry: ({ entryName, normalizedFullPath }) =>
      normalizedFullPath.includes(".test.") ||
      normalizedFullPath.includes(".test-utils.") ||
      normalizedFullPath.includes(".test-harness.") ||
      normalizedFullPath.includes(".test-helpers.") ||
      entryName.endsWith("-test-helpers.ts") ||
      entryName === "test-manager-helpers.ts" ||
      normalizedFullPath.includes(".mock-harness.") ||
      normalizedFullPath.includes(".suite.") ||
      normalizedFullPath.includes(".spec.") ||
      normalizedFullPath.includes(".fixture.") ||
      normalizedFullPath.includes(".snap") ||
      // src/plugin-sdk is the curated bridge layer; validate its contracts with dedicated
      // plugin-sdk guardrails instead of the generic "core should not touch extensions" rule.
      normalizedFullPath.includes(`${normalizedPluginSdkDir}/`),
  });
  return coreSourceFilesCache;
}

function collectExtensionFiles(extensionId: string): string[] {
  const cached = extensionFilesCache.get(extensionId);
  const files = collectSourceFiles(cached, {
    rootDir: resolve(ROOT_DIR, "..", "extensions", extensionId),
    shouldSkipEntry: ({ entryName, normalizedFullPath }) =>
      normalizedFullPath.includes(".test.") ||
      normalizedFullPath.includes(".test-") ||
      normalizedFullPath.includes(".spec.") ||
      normalizedFullPath.includes(".fixture.") ||
      normalizedFullPath.includes(".snap") ||
      entryName === "runtime-api.ts",
  });
  extensionFilesCache.set(extensionId, files);
  return files;
}

function collectModuleSpecifiers(text: string): string[] {
  const patterns = [
    /\bimport\s*\(\s*["']([^"']+\.(?:[cm]?[jt]sx?))["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+\.(?:[cm]?[jt]sx?))["']\s*\)/g,
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+\.(?:[cm]?[jt]sx?))["']/g,
    /\bimport\s*["']([^"']+\.(?:[cm]?[jt]sx?))["']/g,
  ] as const;
  const specifiers = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function collectImportSpecifiers(text: string): string[] {
  return collectModuleSpecifiers(text);
}

function getSourceAnalysis(path: string): SourceAnalysis {
  const fullPath = resolve(REPO_ROOT, path);
  const cached = sourceAnalysisCache.get(fullPath);
  if (cached) {
    return cached;
  }
  const text = readSource(path);
  const importSpecifiers = collectImportSpecifiers(text);
  const analysis = {
    text,
    importSpecifiers,
    extensionImports: importSpecifiers.filter((specifier) => specifier.includes("extensions/")),
  } satisfies SourceAnalysis;
  sourceAnalysisCache.set(fullPath, analysis);
  return analysis;
}

function expectOnlyApprovedExtensionSeams(file: string, imports: string[]): void {
  for (const specifier of imports) {
    const normalized = specifier.replaceAll("\\", "/");
    const resolved = specifier.startsWith(".")
      ? resolve(dirname(file), specifier).replaceAll("\\", "/")
      : normalized;
    const extensionId = resolved.match(/extensions\/([^/]+)\//)?.[1] ?? null;
    if (!extensionId || !GUARDED_CHANNEL_EXTENSIONS.has(extensionId)) {
      continue;
    }
    const basename = resolved.split("/").at(-1) ?? "";
    expect(
      ALLOWED_EXTENSION_PUBLIC_SURFACES.has(basename),
      `${file} should only import approved extension surfaces, got ${specifier}`,
    ).toBe(true);
  }
}

function expectNoSiblingExtensionPrivateSrcImports(file: string, imports: string[]): void {
  const normalizedFile = file.replaceAll("\\", "/");
  const currentExtensionId = normalizedFile.match(/\/extensions\/([^/]+)\//)?.[1] ?? null;
  if (!currentExtensionId) {
    return;
  }
  for (const specifier of imports) {
    if (!specifier.startsWith(".")) {
      continue;
    }
    const resolvedImport = resolve(dirname(file), specifier).replaceAll("\\", "/");
    const targetExtensionId = resolvedImport.match(/\/extensions\/([^/]+)\/src\//)?.[1] ?? null;
    if (!targetExtensionId || targetExtensionId === currentExtensionId) {
      continue;
    }
    expect.fail(`${file} should not import another extension's private src, got ${specifier}`);
  }
}

describe("channel import guardrails", () => {
  it("keeps channel helper modules off their own SDK barrels", () => {
    for (const source of SAME_CHANNEL_SDK_GUARDS) {
      const text = readSource(source.path);
      for (const pattern of source.forbiddenPatterns) {
        expect(text, `${source.path} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps setup barrels limited to setup primitives", () => {
    for (const source of SETUP_BARREL_GUARDS) {
      const importBlock = readSetupBarrelImportBlock(source.path);
      for (const pattern of source.forbiddenPatterns) {
        expect(importBlock, `${source.path} setup import should not match ${pattern}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it("keeps bundled extension source files off root and compat plugin-sdk imports", () => {
    for (const file of collectExtensionSourceFiles()) {
      const analysis = getSourceAnalysis(file);
      expect(analysis.text, `${file} should not import openclaw/plugin-sdk root`).not.toMatch(
        /["']openclaw\/plugin-sdk["']/,
      );
      expect(analysis.text, `${file} should not import openclaw/plugin-sdk/compat`).not.toMatch(
        /["']openclaw\/plugin-sdk\/compat["']/,
      );
    }
  });

  it("keeps bundled extension source files off legacy core send-deps src imports", () => {
    const legacyCoreSendDepsImport = /["'][^"']*src\/infra\/outbound\/send-deps\.[cm]?[jt]s["']/;
    for (const file of collectExtensionSourceFiles()) {
      const analysis = getSourceAnalysis(file);
      expect(analysis.text, `${file} should not import src/infra/outbound/send-deps.*`).not.toMatch(
        legacyCoreSendDepsImport,
      );
    }
  });

  it("keeps core production files off extension private src imports", () => {
    for (const file of collectCoreSourceFiles()) {
      const analysis = getSourceAnalysis(file);
      expect(analysis.text, `${file} should not import extensions/*/src`).not.toMatch(
        /["'][^"']*extensions\/[^/"']+\/src\//,
      );
    }
  });

  it("keeps extension production files off other extensions' private src imports", () => {
    for (const file of collectExtensionSourceFiles()) {
      expectNoSiblingExtensionPrivateSrcImports(file, getSourceAnalysis(file).importSpecifiers);
    }
  });

  it("keeps core extension imports limited to approved public surfaces", () => {
    for (const file of collectCoreSourceFiles()) {
      expectOnlyApprovedExtensionSeams(file, getSourceAnalysis(file).extensionImports);
    }
  });

  it("keeps extension-to-extension imports limited to approved public surfaces", () => {
    for (const file of collectExtensionSourceFiles()) {
      expectOnlyApprovedExtensionSeams(file, getSourceAnalysis(file).extensionImports);
    }
  });

  it("keeps internalized extension helper surfaces behind local api barrels", () => {
    for (const extensionId of LOCAL_EXTENSION_API_BARREL_GUARDS) {
      for (const file of collectExtensionFiles(extensionId)) {
        const normalized = file.replaceAll("\\", "/");
        if (
          LOCAL_EXTENSION_API_BARREL_EXCEPTIONS.some((suffix) => normalized.endsWith(suffix)) ||
          normalized.endsWith("/api.ts") ||
          normalized.endsWith("/test-runtime.ts") ||
          normalized.includes(".test.") ||
          normalized.includes(".spec.") ||
          normalized.includes(".fixture.") ||
          normalized.includes(".snap")
        ) {
          continue;
        }
        const { text } = getSourceAnalysis(file);
        expect(
          text,
          `${normalized} should import ${extensionId} helpers via the local api barrel`,
        ).not.toMatch(new RegExp(`["']openclaw/plugin-sdk/${extensionId}["']`, "u"));
      }
    }
  });
});
