import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFilePath);
const repoRoot = path.resolve(thisDir, "../../..");
const loadConfigPattern = /\b(?:loadConfig|config\.loadConfig)\s*\(/;

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function readRepoFile(relativePath: string): string {
  const absolute = path.join(repoRoot, relativePath);
  return readFileSync(absolute, "utf8");
}

function listCoreOutboundEntryFiles(): string[] {
  const outboundDir = path.join(repoRoot, "src/channels/plugins/outbound");
  return readdirSync(outboundDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => toPosix(path.join("src/channels/plugins/outbound", name)))
    .toSorted();
}

function listExtensionFiles(): {
  adapterEntrypoints: string[];
  inlineChannelEntrypoints: string[];
} {
  const extensionsRoot = path.join(repoRoot, "extensions");
  const adapterEntrypoints: string[] = [];
  const inlineChannelEntrypoints: string[] = [];

  for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const srcDir = path.join(extensionsRoot, entry.name, "src");
    const outboundPath = path.join(srcDir, "outbound.ts");
    if (existsSync(outboundPath)) {
      adapterEntrypoints.push(toPosix(path.join("extensions", entry.name, "src/outbound.ts")));
    }

    const channelPath = path.join(srcDir, "channel.ts");
    if (!existsSync(channelPath)) {
      continue;
    }
    const source = readFileSync(channelPath, "utf8");
    if (source.includes("outbound:")) {
      inlineChannelEntrypoints.push(toPosix(path.join("extensions", entry.name, "src/channel.ts")));
    }
  }

  return {
    adapterEntrypoints: adapterEntrypoints.toSorted(),
    inlineChannelEntrypoints: inlineChannelEntrypoints.toSorted(),
  };
}

function extractOutboundBlock(source: string, file: string): string {
  const outboundKeyIndex = source.indexOf("outbound:");
  expect(outboundKeyIndex, `${file} should define outbound:`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf("{", outboundKeyIndex);
  expect(braceStart, `${file} should define outbound object`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let state: "code" | "single" | "double" | "template" | "lineComment" | "blockComment" = "code";
  for (let i = braceStart; i < source.length; i += 1) {
    const current = source[i];
    const next = source[i + 1];

    if (state === "lineComment") {
      if (current === "\n") {
        state = "code";
      }
      continue;
    }
    if (state === "blockComment") {
      if (current === "*" && next === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }
    if (state === "single") {
      if (current === "\\" && next) {
        i += 1;
        continue;
      }
      if (current === "'") {
        state = "code";
      }
      continue;
    }
    if (state === "double") {
      if (current === "\\" && next) {
        i += 1;
        continue;
      }
      if (current === '"') {
        state = "code";
      }
      continue;
    }
    if (state === "template") {
      if (current === "\\" && next) {
        i += 1;
        continue;
      }
      if (current === "`") {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      state = "lineComment";
      i += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      state = "blockComment";
      i += 1;
      continue;
    }
    if (current === "'") {
      state = "single";
      continue;
    }
    if (current === '"') {
      state = "double";
      continue;
    }
    if (current === "`") {
      state = "template";
      continue;
    }
    if (current === "{") {
      depth += 1;
      continue;
    }
    if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
    }
  }

  throw new Error(`Unable to parse outbound block in ${file}`);
}

describe("outbound cfg-threading guard", () => {
  it("keeps outbound adapter entrypoints free of loadConfig calls", () => {
    const coreAdapterFiles = listCoreOutboundEntryFiles();
    const extensionAdapterFiles = listExtensionFiles().adapterEntrypoints;
    const adapterFiles = [...coreAdapterFiles, ...extensionAdapterFiles];

    for (const file of adapterFiles) {
      const source = readRepoFile(file);
      expect(source, `${file} must not call loadConfig in outbound entrypoint`).not.toMatch(
        loadConfigPattern,
      );
    }
  });

  it("keeps inline channel outbound blocks free of loadConfig calls", () => {
    const inlineFiles = listExtensionFiles().inlineChannelEntrypoints;
    for (const file of inlineFiles) {
      const source = readRepoFile(file);
      const outboundBlock = extractOutboundBlock(source, file);
      expect(outboundBlock, `${file} outbound block must not call loadConfig`).not.toMatch(
        loadConfigPattern,
      );
    }
  });
});
