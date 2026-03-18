import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RUNTIME_API_EXPORT_GUARDS: Record<string, readonly string[]> = {
  "extensions/discord/runtime-api.ts": [
    'export * from "./src/audit.js";',
    'export * from "./src/channel-actions.js";',
    'export * from "./src/directory-live.js";',
    'export * from "./src/monitor.js";',
    'export * from "./src/monitor/gateway-plugin.js";',
    'export * from "./src/monitor/gateway-registry.js";',
    'export * from "./src/monitor/presence-cache.js";',
    'export * from "./src/monitor/thread-bindings.js";',
    'export * from "./src/monitor/thread-bindings.manager.js";',
    'export * from "./src/monitor/timeouts.js";',
    'export * from "./src/probe.js";',
    'export * from "./src/resolve-channels.js";',
    'export * from "./src/resolve-users.js";',
    'export * from "./src/send.js";',
  ],
  "extensions/imessage/runtime-api.ts": [
    'export * from "./src/monitor.js";',
    'export * from "./src/probe.js";',
    'export * from "./src/send.js";',
  ],
  "extensions/nextcloud-talk/runtime-api.ts": [
    'export * from "openclaw/plugin-sdk/nextcloud-talk";',
  ],
  "extensions/signal/runtime-api.ts": ['export * from "./src/index.js";'],
  "extensions/slack/runtime-api.ts": [
    'export * from "./src/directory-live.js";',
    'export * from "./src/index.js";',
    'export * from "./src/resolve-channels.js";',
    'export * from "./src/resolve-users.js";',
  ],
  "extensions/telegram/runtime-api.ts": [
    'export * from "./src/audit.js";',
    'export * from "./src/channel-actions.js";',
    'export * from "./src/monitor.js";',
    'export * from "./src/probe.js";',
    'export * from "./src/send.js";',
    'export * from "./src/thread-bindings.js";',
    'export * from "./src/token.js";',
  ],
  "extensions/whatsapp/runtime-api.ts": [
    'export * from "./src/active-listener.js";',
    'export * from "./src/agent-tools-login.js";',
    'export * from "./src/auth-store.js";',
    'export * from "./src/auto-reply.js";',
    'export * from "./src/inbound.js";',
    'export * from "./src/login.js";',
    'export * from "./src/media.js";',
    'export * from "./src/send.js";',
    'export * from "./src/session.js";',
  ],
} as const;

function collectRuntimeApiFiles(): string[] {
  const extensionsDir = resolve(ROOT_DIR, "..", "extensions");
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
      if (!entry.isFile() || !fullPath.endsWith("/runtime-api.ts")) {
        continue;
      }
      files.push(relative(resolve(ROOT_DIR, ".."), fullPath).replaceAll("\\", "/"));
    }
  }
  return files;
}

function readExportStatements(path: string): string[] {
  return readFileSync(resolve(ROOT_DIR, "..", path), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("export "));
}

describe("runtime api guardrails", () => {
  it("keeps runtime api seams on an explicit export allowlist", () => {
    const runtimeApiFiles = collectRuntimeApiFiles();
    expect(runtimeApiFiles.toSorted()).toEqual(Object.keys(RUNTIME_API_EXPORT_GUARDS).toSorted());

    for (const file of runtimeApiFiles) {
      expect(readExportStatements(file), `${file} runtime api exports changed`).toEqual(
        RUNTIME_API_EXPORT_GUARDS[file],
      );
    }
  });
});
