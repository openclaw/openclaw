import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readMemoryArtifactProvenance } from "../../../memory/memory-artifact-provenance.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(flushSessionMemoryWritesForTest);

it("retains overlapping daily/idle captures with matching content and provenance", async () => {
  const tempDir = tempDirs.make("openclaw-session-memory-auto-");
  const storePath = path.join(tempDir, "sessions.json");
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: tempDir, userTimezone: "UTC" } },
    session: { store: storePath },
  };
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    sessionId: `concurrent-${index}`,
    sessionKey: `agent:main:concurrent-${index}`,
    marker: `capture-${index}-only`,
    senderIsOwner: index % 2 === 0,
    reason: index % 2 === 0 ? "daily" : "idle",
  }));
  for (const session of sessions) {
    await replaceTranscriptEvents(
      { agentId: "main", storePath, ...session },
      [session.marker, "Captured automatically"].map((content, index) => ({
        type: "message",
        id: String(index),
        parentId: index ? "0" : null,
        message: {
          role: index ? "assistant" : "user",
          content,
          __openclaw: index ? undefined : { senderIsOwner: session.senderIsOwner },
        },
      })),
    );
  }

  await Promise.all(
    sessions.map(async (session) => {
      const event = createInternalHookEvent("session", "auto-reset", session.sessionKey, {
        cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath,
        sessionEntry: { sessionId: session.sessionId },
        reason: session.reason,
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
    expect(artifact.content).toContain(`- **Reason**: ${session.reason}`);
    expect(artifact.content).toContain(`user: ${JSON.stringify(session.marker)}`);
    expect(artifact.content).toContain('assistant: "Captured automatically"');
    expect(artifact.provenance).toMatchObject({
      fileHash: createHash("sha256").update(artifact.content).digest("hex"),
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      originClass: session.senderIsOwner ? "agent" : "untrusted",
    });
  }
});
