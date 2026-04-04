import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

function acpMeta() {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
}

describe("updateSessionStoreAfterAgentRun", () => {
  it("preserves ACP metadata when caller has a stale session snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:acp:${randomUUID()}`;
    const sessionId = randomUUID();

    const existing: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      acp: acpMeta(),
    };
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: existing }, null, 2), "utf8");

    const staleInMemory: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore: staleInMemory,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.acp).toBeDefined();
    expect(staleInMemory[sessionKey]?.acp).toBeDefined();
  });

  it("does not clobber terminal status already written to disk by lifecycle handler", async () => {
    // Regression test for #60250.
    // persistGatewaySessionLifecycleEvent (fire-and-forget) writes the terminal
    // status to disk before updateSessionStoreAfterAgentRun runs. The in-memory
    // sessionStore carries a stale status: "running" because it was loaded before
    // the lifecycle end event fired. This test asserts that the stale in-memory
    // status does not overwrite the terminal status on disk.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:default:lifecycle:${randomUUID()}`;
    const sessionId = randomUUID();
    const endedAt = Date.now();

    // Disk already has the terminal state written by the lifecycle end handler.
    const diskState: SessionEntry = {
      sessionId,
      updatedAt: endedAt,
      status: "done",
      endedAt,
      runtimeMs: 1234,
    };
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: diskState }, null, 2), "utf8");

    // In-memory sessionStore has a stale status: "running" (loaded before the run ended).
    const staleInMemory: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: endedAt - 2000,
        status: "running",
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore: staleInMemory,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "openai-codex",
            model: "gpt-5.4",
            usage: { input: 100, output: 50 },
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    // Terminal status must be preserved, not overwritten with stale "running".
    expect(persisted?.status).toBe("done");
    // endedAt and runtimeMs written by the lifecycle handler must be preserved.
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(1234);
    // Token fields from this run should have been merged in.
    expect(persisted?.inputTokens).toBe(100);
    expect(persisted?.outputTokens).toBe(50);
  });

  it("persists latest systemPromptReport for downstream warning dedupe", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:report:${randomUUID()}`;
    const sessionId = randomUUID();

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

    const report = {
      source: "run" as const,
      generatedAt: Date.now(),
      bootstrapTruncation: {
        warningMode: "once" as const,
        warningSignaturesSeen: ["sig-a", "sig-b"],
      },
      systemPrompt: {
        chars: 1,
        projectContextChars: 1,
        nonProjectContextChars: 0,
      },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 0, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      result: {
        payloads: [],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
          },
          systemPromptReport: report,
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.systemPromptReport?.bootstrapTruncation?.warningSignaturesSeen).toEqual([
      "sig-a",
      "sig-b",
    ]);
    expect(sessionStore[sessionKey]?.systemPromptReport?.bootstrapTruncation?.warningMode).toBe(
      "once",
    );
  });
});
