import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_EXTENSION_PUBLIC_SEAMS = new Set([
  "action-runtime.runtime.js",
  "api.js",
  "index.js",
  "login-qr-api.js",
  "runtime-api.js",
  "setup-api.js",
  "setup-entry.js",
]);
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
  "qwen-portal-auth",
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
  // accounts.ts -> runtime-api.ts -> openclaw/plugin-sdk/matrix -> extensions/matrix/api.ts -> accounts.ts
  "extensions/matrix/src/matrix/accounts.ts",
] as const;

function readSource(path: string): string {
  return readFileSync(resolve(ROOT_DIR, "..", path), "utf8");
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
  const extensionsDir = resolve(ROOT_DIR, "..", "extensions");
  const sharedExtensionsDir = resolve(extensionsDir, "shared");
  const files: string[] = [];
  const stack = [extensionsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(entry.name)) {
        continue;
      }
      if (entry.name.endsWith(".d.ts") || fullPath.includes(sharedExtensionsDir)) {
        continue;
      }
      if (fullPath.includes(`${resolve(ROOT_DIR, "..", "extensions")}/shared/`)) {
        continue;
      }
      if (
        fullPath.includes(".test.") ||
        fullPath.includes(".test-") ||
        fullPath.includes(".fixture.") ||
        fullPath.includes(".snap") ||
        fullPath.includes("test-support") ||
        entry.name === "api.ts" ||
        entry.name === "runtime-api.ts"
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

function collectCoreSourceFiles(): string[] {
  const srcDir = resolve(ROOT_DIR, "..", "src");
  const files: string[] = [];
  const stack = [srcDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
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
        fullPath.includes(".test.") ||
        fullPath.includes(".spec.") ||
        fullPath.includes(".fixture.") ||
        fullPath.includes(".snap") ||
        // src/plugin-sdk is the curated bridge layer; validate its contracts with dedicated
        // plugin-sdk guardrails instead of the generic "core should not touch extensions" rule.
        fullPath.includes(`${resolve(ROOT_DIR, "plugin-sdk")}/`)
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

function collectExtensionFiles(extensionId: string): string[] {
  const extensionDir = resolve(ROOT_DIR, "..", "extensions", extensionId);
  const files: string[] = [];
  const stack = [extensionDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
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
        fullPath.includes(".test.") ||
        fullPath.includes(".test-") ||
        fullPath.includes(".spec.") ||
        fullPath.includes(".fixture.") ||
        fullPath.includes(".snap") ||
        entry.name === "runtime-api.ts"
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

function collectExtensionImports(text: string): string[] {
  return [...text.matchAll(/["']([^"']*extensions\/[^"']+\.(?:[cm]?[jt]sx?))["']/g)].map(
    (match) => match[1] ?? "",
  );
}

function expectOnlyApprovedExtensionSeams(file: string, imports: string[]): void {
  for (const specifier of imports) {
    const normalized = specifier.replaceAll("\\", "/");
    const extensionId = normalized.match(/extensions\/([^/]+)\//)?.[1] ?? null;
    if (!extensionId || !GUARDED_CHANNEL_EXTENSIONS.has(extensionId)) {
      continue;
    }
    const basename = normalized.split("/").at(-1) ?? "";
    expect(
      ALLOWED_EXTENSION_PUBLIC_SEAMS.has(basename),
      `${file} should only import approved extension seams, got ${specifier}`,
    ).toBe(true);
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
      const text = readFileSync(file, "utf8");
      expect(text, `${file} should not import openclaw/plugin-sdk root`).not.toMatch(
        /["']openclaw\/plugin-sdk["']/,
      );
      expect(text, `${file} should not import openclaw/plugin-sdk/compat`).not.toMatch(
        /["']openclaw\/plugin-sdk\/compat["']/,
      );
    }
  });

  it("keeps extension production files off direct core src imports", () => {
    for (const file of collectExtensionSourceFiles()) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} should not import ../../src/* core internals directly`).not.toMatch(
        /["'][^"']*(?:\.\.\/){2,}src\//,
      );
    }
  });

  it("keeps core production files off extension private src imports", () => {
    for (const file of collectCoreSourceFiles()) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} should not import extensions/*/src`).not.toMatch(
        /["'][^"']*extensions\/[^/"']+\/src\//,
      );
    }
  });

  it("keeps extension production files off other extensions' private src imports", () => {
    for (const file of collectExtensionSourceFiles()) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} should not import another extension's src`).not.toMatch(
        /["'][^"']*\.\.\/(?:\.\.\/)?(?!src\/)[^/"']+\/src\//,
      );
    }
  });

  it("keeps core extension imports limited to approved public seams", () => {
    for (const file of collectCoreSourceFiles()) {
      expectOnlyApprovedExtensionSeams(file, collectExtensionImports(readFileSync(file, "utf8")));
    }
  });

  it("keeps extension-to-extension imports limited to approved public seams", () => {
    for (const file of collectExtensionSourceFiles()) {
      expectOnlyApprovedExtensionSeams(file, collectExtensionImports(readFileSync(file, "utf8")));
    }
  });

  it("keeps internalized extension helper seams behind local api barrels", () => {
    for (const extensionId of LOCAL_EXTENSION_API_BARREL_GUARDS) {
      for (const file of collectExtensionFiles(extensionId)) {
        const normalized = file.replaceAll("\\", "/");
        if (
          LOCAL_EXTENSION_API_BARREL_EXCEPTIONS.some((suffix) => normalized.endsWith(suffix)) ||
          normalized.endsWith("/api.ts") ||
          normalized.includes(".test.") ||
          normalized.includes(".spec.") ||
          normalized.includes(".fixture.") ||
          normalized.includes(".snap")
        ) {
          continue;
        }
        const text = readFileSync(file, "utf8");
        expect(
          text,
          `${normalized} should import ${extensionId} helpers via the local api barrel`,
        ).not.toMatch(new RegExp(`["']openclaw/plugin-sdk/${extensionId}["']`, "u"));
      }
    }
  });
});
