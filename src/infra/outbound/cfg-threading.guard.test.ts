// Guards outbound/channel entrypoints from runtime config reads that would
// force plugin discovery or filesystem scans on standard message actions.
import { spawnSync } from "node:child_process";
import fs, { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  listGitTrackedFiles,
  sortRepoPaths,
  toRepoRelativePath,
} from "../../test-utils/repo-files.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const loadConfigPattern = /\b(?:getRuntimeConfig|config\.getRuntimeConfig)\s*\(/;

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function listFindFiles(args: string[]): string[] | null {
  const result = spawnSync("find", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => toRepoRelativePath(repoRoot, file))
    .toSorted((left, right) => left.localeCompare(right));
}

function listCoreOutboundEntryFiles(): string[] {
  const outboundDir = path.join(repoRoot, "src/channels/plugins/outbound");
  const externalFiles =
    listGitTrackedFiles({ repoRoot, pathspecs: ["src/channels/plugins/outbound/*.ts"] }) ??
    listFindFiles([outboundDir, "-maxdepth", "1", "-type", "f", "-name", "*.ts"]);
  if (externalFiles) {
    return sortRepoPaths(externalFiles.filter((file) => !file.endsWith(".test.ts")));
  }

  return fs
    .readdirSync(outboundDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => toRepoRelativePath(repoRoot, path.join(outboundDir, name)))
    .toSorted();
}

function listExtensionFiles(): {
  adapterEntrypoints: string[];
  inlineChannelEntrypoints: string[];
} {
  const externalFiles =
    listGitTrackedFiles({
      repoRoot,
      pathspecs: ["extensions/*/src/outbound.ts", "extensions/*/src/channel.ts"],
    }) ??
    listFindFiles([
      path.join(repoRoot, "extensions"),
      "-path",
      "*/src/outbound.ts",
      "-o",
      "-path",
      "*/src/channel.ts",
    ]);
  if (externalFiles) {
    return partitionExtensionEntrypoints(externalFiles);
  }

  const extensionsRoot = path.join(repoRoot, "extensions");
  return partitionExtensionEntrypoints(
    fs
      .readdirSync(extensionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        ["outbound.ts", "channel.ts"].map((name) =>
          path.posix.join("extensions", entry.name, "src", name),
        ),
      )
      .filter((file) => existsSync(path.join(repoRoot, file))),
  );
}

function partitionExtensionEntrypoints(files: string[]): {
  adapterEntrypoints: string[];
  inlineChannelEntrypoints: string[];
} {
  return {
    adapterEntrypoints: files.filter((file) => file.endsWith("/src/outbound.ts")).toSorted(),
    inlineChannelEntrypoints: files
      .filter(
        (file) =>
          file.endsWith("/src/channel.ts") && /\boutbound\s*:\s*\{/.test(readRepoFile(file)),
      )
      .toSorted(),
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
    if (state === "single" || state === "double" || state === "template") {
      if (current === "\\" && next) {
        i += 1;
        continue;
      }
      const quote = { single: "'", double: '"', template: "`" }[state];
      if (current === quote) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && (next === "/" || next === "*")) {
      state = next === "/" ? "lineComment" : "blockComment";
      i += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      state = current === "'" ? "single" : current === '"' ? "double" : "template";
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
  it("keeps outbound adapter entrypoints free of getRuntimeConfig calls", () => {
    const coreAdapterFiles = listCoreOutboundEntryFiles();
    const extensionAdapterFiles = listExtensionFiles().adapterEntrypoints;
    const adapterFiles = [...coreAdapterFiles, ...extensionAdapterFiles];
    expect(coreAdapterFiles.length).toBeGreaterThan(0);
    expect(extensionAdapterFiles.length).toBeGreaterThan(0);

    for (const file of adapterFiles) {
      const source = readRepoFile(file);
      expect(source, `${file} must not call getRuntimeConfig in outbound entrypoint`).not.toMatch(
        loadConfigPattern,
      );
    }
  });

  it("keeps inline channel outbound blocks free of getRuntimeConfig calls", () => {
    const inlineFiles = listExtensionFiles().inlineChannelEntrypoints;
    for (const file of inlineFiles) {
      const source = readRepoFile(file);
      const outboundBlock = extractOutboundBlock(source, file);
      expect(outboundBlock, `${file} outbound block must not call getRuntimeConfig`).not.toMatch(
        loadConfigPattern,
      );
    }
  });

  it("keeps high-risk runtime delivery paths free of getRuntimeConfig calls", () => {
    for (const file of [
      bundledPluginFile("telegram", "src/action-runtime.ts"),
      bundledPluginFile("discord", "src/monitor/reply-delivery.ts"),
      bundledPluginFile("discord", "src/monitor/thread-bindings.discord-api.ts"),
      bundledPluginFile("discord", "src/monitor/thread-bindings.manager.ts"),
    ]) {
      const source = readRepoFile(file);
      expect(source, `${file} must not call getRuntimeConfig`).not.toMatch(loadConfigPattern);
    }
  });
});
