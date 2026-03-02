import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

function appendToolResult(sm: ReturnType<typeof SessionManager.inMemory>, text: string): void {
  const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
  appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
  } as AgentMessage);
  appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    isError: false,
    content: [{ type: "text", text }],
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any);
}

function getPersistedToolResult(
  sm: ReturnType<typeof SessionManager.inMemory>,
): Record<string, unknown> {
  const messages = sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
  // oxlint-disable-next-line typescript/no-explicit-any
  return messages.find((m) => (m as any).role === "toolResult") as any;
}

afterEach(() => {
  resetGlobalHookRunner();
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_TONL_MIN_CHARS;
});

describe("tonl-tool-result-persist plugin", () => {
  it("encodes large JSON payloads to TONL and records savings metadata", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tonl-plugin-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginPath =
      "/root/clawd/openclaw/extensions/tonl-tool-result-persist/tonl-tool-result-persist.mjs";

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginPath] },
          allow: ["tonl-tool-result-persist"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    const payload = JSON.stringify(
      {
        project: "openclaw",
        stats: { tokens: 12345, cacheRead: 555, cacheWrite: 222 },
        files: Array.from({ length: 40 }, (_, i) => ({
          path: `src/mod-${i}.ts`,
          size: i * 37 + 100,
          hash: `abcd${i}`,
        })),
        notes: "x".repeat(800),
      },
      null,
      2,
    );

    appendToolResult(sm, payload);

    const persisted = getPersistedToolResult(sm);
    const text = (
      (persisted.content as Array<{ type?: string; text?: string }> | undefined) ?? []
    ).find((b) => b?.type === "text")?.text;

    expect(text).toContain("[format: tonl]");
    expect(text).toContain("[/format]");
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((persisted as any).tonl?.encoded).toBe(true);
    // oxlint-disable-next-line typescript/no-explicit-any
    expect(Number((persisted as any).tonl?.savedTokensEstimate ?? 0)).toBeGreaterThan(0);
  });

  it("keeps payload unchanged when below minimum size threshold", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tonl-plugin-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    process.env.OPENCLAW_TONL_MIN_CHARS = "5000";

    const pluginPath =
      "/root/clawd/openclaw/extensions/tonl-tool-result-persist/tonl-tool-result-persist.mjs";

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginPath] },
          allow: ["tonl-tool-result-persist"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    const payload = JSON.stringify({ ok: true, msg: "small payload" }, null, 2);
    appendToolResult(sm, payload);
    const persisted = getPersistedToolResult(sm);
    const text = (
      (persisted.content as Array<{ type?: string; text?: string }> | undefined) ?? []
    ).find((b) => b?.type === "text")?.text;

    expect(text).toBe(payload);
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((persisted as any).tonl).toBeUndefined();
  });
});
