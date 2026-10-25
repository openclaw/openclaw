import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSessionCatalogJsonlActivity } from "./session-catalog-jsonl-activity.js";
import type { SessionUpstreamProbe } from "./session-catalog.js";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));

// mock-isolation: Capture the operator warning without writing process-global log files.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const probe: SessionUpstreamProbe = {
  sessionKey: "agent:main:catalog-test",
  agentId: "main",
  threadId: "thread-test",
  hostId: "gateway",
  upstreamKind: "pi-cli",
  upstreamRef: {},
  marker: { offset: 0 },
  ownRecentUserTexts: [],
};

function readActivity(filePath: string, offset = 0) {
  return readSessionCatalogJsonlActivity({
    probe,
    filePath,
    offset,
    classifyLine: (line) => ({ userText: line, occurredAt: 1000 }),
  });
}

describe("session catalog JSONL activity", () => {
  beforeEach(() => mocks.warn.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps readable, idle, and missing transcripts quiet", async () => {
    const filePath = path.join(tempDirs.make("catalog-activity-"), "transcript.jsonl");
    await fs.writeFile(filePath, "hello\n");
    await expect(readActivity(filePath)).resolves.toEqual({
      kind: "activity",
      sessionKey: probe.sessionKey,
      humanTurns: 1,
      nextMarker: { offset: 6 },
      occurredAt: 1000,
      dedupeId: "6",
    });
    await expect(readActivity(filePath, 6)).resolves.toBeUndefined();
    await expect(readActivity(`${filePath}.missing`)).resolves.toEqual({
      kind: "missing",
      sessionKey: probe.sessionKey,
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "EBUSY", "ENOTDIR"])(
    "reports %s without classifying a transcript as missing",
    async (code) => {
      const error = Object.assign(new Error(`${code}: cannot open transcript`), { code });
      vi.spyOn(fs, "open").mockRejectedValueOnce(error);
      await expect(readActivity("transcript.jsonl")).resolves.toBeUndefined();
      expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(probe.sessionKey));
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(code));
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("Check the transcript path"));
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("automatically retried"));
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a real permission-denied transcript and can read it after access is restored",
    async () => {
      const filePath = path.join(tempDirs.make("catalog-unreadable-"), "transcript.jsonl");
      await fs.writeFile(filePath, "hello\n", { mode: 0o600 });
      await fs.chmod(filePath, 0o000);
      try {
        // Prove the fixture is unreadable rather than relying on chmod semantics alone.
        await expect(fs.open(filePath, "r")).rejects.toMatchObject({ code: "EACCES" });
        await expect(readActivity(filePath)).resolves.toBeUndefined();
        expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("EACCES"));
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(probe.sessionKey));
      } finally {
        await fs.chmod(filePath, 0o600);
      }
      await expect(readActivity(filePath)).resolves.toMatchObject({
        kind: "activity",
        humanTurns: 1,
        nextMarker: { offset: 6 },
      });
    },
  );
});
