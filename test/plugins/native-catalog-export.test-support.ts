import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import acpx from "../../extensions/acpx/index.js";
import anthropic from "../../extensions/anthropic/index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../../src/plugins/registry-runtime.test-helpers.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";

export function createNativeCatalogTestRegistry(config: OpenClawConfig) {
  const builder = createRuntimeTestRegistry(createPluginRuntime());
  for (const plugin of [anthropic, acpx]) {
    const record = createPluginRecord({
      id: plugin.id,
      source: plugin.id,
      origin: "bundled",
      enabled: true,
      configSchema: true,
    });
    plugin.register(builder.createApi(record, { config }));
  }
  return builder;
}

export async function createNativeExportFixture(
  root: string,
  catalog: "claude" | "pi",
  newerSessions = 101,
) {
  const threadId = "ad0ea4ed-b8c7-41f3-a844-653b4341e0bc";
  const claudeDir = path.join(root, ".claude");
  const piDir = path.join(root, ".pi", "agent", "sessions", "project");
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, ".openclaw"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, ".pi", "agent"));
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", piDir);
  const directory = catalog === "claude" ? path.join(claudeDir, "projects", "project") : piDir;
  await fs.mkdir(directory, { recursive: true });
  let selectedFile = "";
  const epoch = Date.UTC(2026, 0, 1);
  await Promise.all(
    Array.from({ length: newerSessions + 1 }, async (_, index) => {
      const selected = index === 0;
      const id = selected ? threadId : randomUUID();
      const cwd = selected ? "/workspace/project" : "/workspace/" + threadId;
      const modified = new Date(epoch + index * 1_000);
      const timestamp = modified.toISOString();
      const content = selected ? "visible selected message" : "unrelated message";
      const message = { role: "user", content };
      const entries =
        catalog === "claude"
          ? [
              {
                type: "user",
                entrypoint: "cli",
                uuid: randomUUID(),
                sessionId: id,
                cwd,
                timestamp,
                message,
              },
            ]
          : [
              { type: "session", version: 3, id, cwd, timestamp },
              { type: "message", id: "cafe0001", parentId: null, timestamp, message },
            ];
      const name =
        catalog === "claude" ? id : timestamp.replaceAll(":", "-").replace(".", "-") + "_" + id;
      const file = path.join(directory, name + ".jsonl");
      await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      await fs.utimes(file, modified, modified);
      if (selected) {
        selectedFile = await fs.realpath(file);
      }
    }),
  );
  return {
    hostId: catalog === "claude" ? "gateway:local" : "gateway",
    threadId,
    sourceHomeId: createHash("sha256").update(selectedFile).digest("hex"),
  };
}
