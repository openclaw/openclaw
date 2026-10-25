import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readMemoryArtifactProvenance } from "../../../memory/memory-artifact-provenance.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-memory automatic reset", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-session-memory-auto-");
  });

  afterEach(async () => {
    await flushSessionMemoryWritesForTest();
  });

  it("retains overlapping captures with matching content and provenance", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = {
      agents: { defaults: { workspace: tempDir, userTimezone: "UTC" } },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      sessionId: `concurrent-${index}`,
      sessionKey: `agent:main:concurrent-${index}`,
      marker: `capture-${index}-only`,
      senderIsOwner: index % 2 === 0,
    }));
    for (const session of sessions) {
      await replaceTranscriptEvents({ agentId: "main", storePath, ...session }, [
        {
          type: "message",
          id: `${session.sessionId}-user`,
          parentId: null,
          message: {
            role: "user",
            content: session.marker,
            __openclaw: { senderIsOwner: session.senderIsOwner },
          },
        },
      ]);
    }

    await Promise.all(
      sessions.map(async (session) => {
        const event = createInternalHookEvent("session", "auto-reset", session.sessionKey, {
          cfg,
          agentId: "main",
          workspaceDir: tempDir,
          storePath,
          sessionEntry: { sessionId: session.sessionId },
          reason: "idle",
        });
        event.timestamp = new Date("2026-10-21T20:30:00.000Z");
        await handler(event);
      }),
    );

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    expect(files).toHaveLength(sessions.length);
    const artifacts = await Promise.all(
      files.map(async (filename) => ({
        content: await fs.readFile(path.join(memoryDir, filename), "utf8"),
        provenance: await readMemoryArtifactProvenance({
          workspaceDir: tempDir,
          relativePath: `memory/${filename}`,
        }),
      })),
    );
    for (const session of sessions) {
      const matches = artifacts.filter(({ content }) => content.includes(session.marker));
      expect(matches).toHaveLength(1);
      const artifact = expectDefined(matches[0], "capture must be retained exactly once");
      expect(artifact.provenance).toMatchObject({
        fileHash: createHash("sha256").update(artifact.content).digest("hex"),
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        originClass: session.senderIsOwner ? "agent" : "untrusted",
      });
    }
  });

  it.each(["daily", "idle"] as const)(
    "creates memory from the ended session on %s reset",
    async (reason) => {
      const sessionKey = "agent:main:main";
      const sessionId = `${reason}-session`;
      const storePath = path.join(tempDir, "sessions.json");
      const cfg = {
        agents: { defaults: { workspace: tempDir } },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "message",
          id: `${reason}-user`,
          parentId: null,
          message: {
            role: "user",
            content: `Remember the ${reason} rollover`,
            __openclaw: { senderIsOwner: true },
          },
        },
        {
          type: "message",
          id: `${reason}-assistant`,
          parentId: `${reason}-user`,
          message: { role: "assistant", content: "Captured automatically" },
        },
      ]);
      const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
        cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath,
        sessionEntry: { sessionId },
        reason,
      });

      const completed = handler(event);
      expect(completed).toBeInstanceOf(Promise);
      await completed;

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      const memoryContent = await fs.readFile(
        path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
        "utf8",
      );
      expect(files).toHaveLength(1);
      expect(memoryContent).toContain(`- **Reason**: ${reason}`);
      expect(memoryContent).toContain(`user: ${JSON.stringify(`Remember the ${reason} rollover`)}`);
      expect(memoryContent).toContain(`assistant: ${JSON.stringify("Captured automatically")}`);
    },
  );
});
