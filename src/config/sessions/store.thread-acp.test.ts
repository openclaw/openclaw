import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { recordSessionMetaFromInbound } from "./store.js";
import type { SessionEntry } from "./types.js";

function stubCtx(): MsgContext {
  return { MessageId: "msg1" } as MsgContext;
}

describe("thread-bound ACP session metadata", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-acp-test-"));
    const sessionsDir = path.join(tempDir, "agents", "codex", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies acp metadata from base session to simple thread-bound session", async () => {
    // Create base session with acp metadata
    const baseKey = "agent:codex:acp:c061ee55-6a02-4b45-a632-84dae6b1e31c";
    const baseSession: SessionEntry = {
      sessionId: "base-session",
      updatedAt: Date.now(),
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "acpx:v1:test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        identity: {
          state: "resolved",
          acpxRecordId: "019cf750-8267-7f02-bce4-f5d5a74adcda",
          acpxSessionId: "019cf750-8267-7f02-bce4-f5d5a74adcda",
          source: "ensure",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    fs.writeFileSync(storePath, JSON.stringify({ [baseKey]: baseSession }));

    // Create thread-bound session
    const threadKey = `${baseKey}:thread:46971`;
    const result = await recordSessionMetaFromInbound({
      storePath,
      sessionKey: threadKey,
      ctx: stubCtx(),
    });

    expect(result?.acp).toEqual(baseSession.acp);
  });

  it("copies acp metadata for Telegram DM thread with colon in threadId", async () => {
    const baseKey = "agent:main:main";
    const baseSession: SessionEntry = {
      sessionId: "base-session",
      updatedAt: Date.now(),
      acp: {
        backend: "acpx",
        agent: "main",
        runtimeSessionName: "acpx:v1:test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        identity: {
          state: "resolved",
          acpxRecordId: "test-record-id",
          acpxSessionId: "test-session-id",
          source: "ensure",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    fs.writeFileSync(storePath, JSON.stringify({ [baseKey]: baseSession }));

    // Telegram DM thread format: thread:chatId:dmThreadId
    const threadKey = `${baseKey}:thread:1234:42`;
    const result = await recordSessionMetaFromInbound({
      storePath,
      sessionKey: threadKey,
      ctx: stubCtx(),
    });

    expect(result?.acp).toEqual(baseSession.acp);
  });

  it("copies acp metadata for Telegram topic session", async () => {
    const baseKey = "agent:codex:acp:base-id";
    const baseSession: SessionEntry = {
      sessionId: "base-session",
      updatedAt: Date.now(),
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "acpx:v1:test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        identity: {
          state: "resolved",
          acpxRecordId: "topic-record-id",
          acpxSessionId: "topic-session-id",
          source: "ensure",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    fs.writeFileSync(storePath, JSON.stringify({ [baseKey]: baseSession }));

    // Telegram topic format
    const topicKey = `${baseKey}:topic:123`;
    const result = await recordSessionMetaFromInbound({
      storePath,
      sessionKey: topicKey,
      ctx: stubCtx(),
    });

    expect(result?.acp).toEqual(baseSession.acp);
  });

  it("does not copy if thread session already has acp metadata", async () => {
    const baseKey = "agent:codex:acp:base-id";
    const threadKey = `${baseKey}:thread:123`;

    const existingAcp = { backend: "existing", agent: "test" } as SessionEntry["acp"];
    const threadSession: SessionEntry = {
      sessionId: "thread-session",
      updatedAt: Date.now(),
      acp: existingAcp,
    };

    fs.writeFileSync(storePath, JSON.stringify({ [threadKey]: threadSession }));

    const result = await recordSessionMetaFromInbound({
      storePath,
      sessionKey: threadKey,
      ctx: stubCtx(),
    });

    expect(result?.acp).toEqual(existingAcp);
  });

  it("handles missing base session gracefully", async () => {
    const threadKey = "agent:codex:acp:missing-base:thread:123";

    fs.writeFileSync(storePath, JSON.stringify({}));

    const result = await recordSessionMetaFromInbound({
      storePath,
      sessionKey: threadKey,
      ctx: stubCtx(),
    });

    expect(result?.acp).toBeUndefined();
  });

  it("copies acp to existing thread session without acp", async () => {
    const baseKey = "agent:codex:acp:base-id";
    const threadKey = `${baseKey}:thread:123`;

    const baseSession: SessionEntry = {
      sessionId: "base-session",
      updatedAt: Date.now(),
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "acpx:v1:test",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        identity: {
          state: "resolved",
          acpxRecordId: "base-record-id",
          acpxSessionId: "base-session-id",
          source: "ensure",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    const threadSession: SessionEntry = {
      sessionId: "thread-session",
      updatedAt: Date.now(),
      origin: { provider: "telegram" } as SessionEntry["origin"],
    };

    fs.writeFileSync(
      storePath,
      JSON.stringify({ [baseKey]: baseSession, [threadKey]: threadSession }),
    );

    const result = await recordSessionMetaFromInbound({
      storePath,
      sessionKey: threadKey,
      ctx: stubCtx(),
    });

    expect(result?.acp).toEqual(baseSession.acp);
  });
});
