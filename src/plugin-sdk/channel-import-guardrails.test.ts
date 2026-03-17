import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type GuardedSource = {
  path: string;
  forbiddenPatterns: RegExp[];
};

const SAME_CHANNEL_SDK_GUARDS: GuardedSource[] = [
  {
    path: "extensions/discord/src/plugin-shared.ts",
    forbiddenPatterns: [/openclaw\/plugin-sdk\/discord/, /plugin-sdk-internal\/discord/],
  },
  {
    path: "extensions/discord/src/shared.ts",
    forbiddenPatterns: [/openclaw\/plugin-sdk\/discord/, /plugin-sdk-internal\/discord/],
  },
  {
    path: "extensions/slack/src/shared.ts",
    forbiddenPatterns: [/openclaw\/plugin-sdk\/slack/, /plugin-sdk-internal\/slack/],
  },
  {
    path: "extensions/telegram/src/shared.ts",
    forbiddenPatterns: [/openclaw\/plugin-sdk\/telegram/, /plugin-sdk-internal\/telegram/],
  },
  {
    path: "extensions/imessage/src/shared.ts",
    forbiddenPatterns: [/openclaw\/plugin-sdk\/imessage/, /plugin-sdk-internal\/imessage/],
  },
  {
    path: "extensions/whatsapp/src/shared.ts",
    forbiddenPatterns: [/openclaw\/plugin-sdk\/whatsapp/, /plugin-sdk-internal\/whatsapp/],
  },
  {
    path: "extensions/signal/src/shared.ts",
    forbiddenPatterns: [/openclaw\/plugin-sdk\/signal/, /plugin-sdk-internal\/signal/],
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
});
