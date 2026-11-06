// Outbound entrypoints must use their supplied config, not discover it at runtime.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const loadConfigPattern = /\b(?:getRuntimeConfig|config\.getRuntimeConfig)\s*\(/;
const coreDirectory = "src/channels/plugins/outbound";
const coreFiles = fs
  .readdirSync(path.join(repoRoot, coreDirectory))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => path.posix.join(coreDirectory, name));
const extensionFiles = fs
  .readdirSync(path.join(repoRoot, "extensions"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    ["outbound.ts", "channel.ts"].map((name) =>
      path.posix.join("extensions", entry.name, "src", name),
    ),
  )
  .filter((file) => fs.existsSync(path.join(repoRoot, file)));

function extractOutboundBlock(source: string, file: string): string {
  const key = source.indexOf("outbound:");
  expect(key, file).toBeGreaterThanOrEqual(0);
  const start = source.indexOf("{", key);
  expect(start, file).toBeGreaterThanOrEqual(0);
  let depth = 0;
  // Consume comments and quoted strings whole so their braces do not affect depth.
  const tokens =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[{}]/g;
  for (const token of source.slice(start).matchAll(tokens)) {
    if (token[0] === "{") {
      depth += 1;
    } else if (token[0] === "}" && --depth === 0) {
      return source.slice(start, start + token.index + 1);
    }
  }
  throw new Error(`Unable to parse outbound block in ${file}`);
}

it.each([
  ["core adapters", coreFiles],
  ["extension adapters", extensionFiles.filter((file) => file.endsWith("/outbound.ts"))],
  [
    "high-risk runtime paths",
    [
      bundledPluginFile("telegram", "src/action-runtime.ts"),
      bundledPluginFile("discord", "src/monitor/reply-delivery.ts"),
      bundledPluginFile("discord", "src/monitor/thread-bindings.discord-api.ts"),
      bundledPluginFile("discord", "src/monitor/thread-bindings.manager.ts"),
    ],
  ],
] as const)("keeps %s free of runtime config reads", (_scope, files) => {
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(read(file), file).not.toMatch(loadConfigPattern);
  }
});

it("keeps inline channel outbound blocks free of runtime config reads", () => {
  const channels = extensionFiles.filter((file) => file.endsWith("/channel.ts"));
  for (const file of channels) {
    const source = read(file);
    if (/\boutbound\s*:\s*\{/.test(source)) {
      expect(extractOutboundBlock(source, file), file).not.toMatch(loadConfigPattern);
    }
  }
});
