import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUpstreamProbe } from "./session-catalog.js";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

import { readSessionCatalogJsonlActivity } from "./session-catalog-jsonl-activity.js";

const probe: SessionUpstreamProbe = {
  sessionKey: "agent:main:adopted:claude",
  agentId: "main",
  threadId: "thread-1",
  hostId: "gateway:local",
  upstreamKind: "claude-cli",
  upstreamRef: { filePath: "/unreadable/thread.jsonl" },
  marker: { offset: 0 },
  ownRecentUserTexts: [],
};

function readActivity(filePath = "/unreadable/thread.jsonl") {
  return readSessionCatalogJsonlActivity({
    probe,
    filePath,
    offset: 0,
    classifyLine: () => undefined,
  });
}

describe("readSessionCatalogJsonlActivity", () => {
  beforeEach(() => {
    mocks.warn.mockClear();
  });

  it.each(["EACCES", "EPERM", "EBUSY"])(
    "logs a non-missing %s open failure without changing its retry outcome",
    async (code) => {
      vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("open failed"), { code }));

      await expect(readActivity()).resolves.toBeUndefined();
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "failed to read session catalog transcript /unreadable/thread.jsonl",
        ),
      );
    },
  );

  it("keeps missing transcripts silent", async () => {
    vi.spyOn(fs, "open").mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    await expect(readActivity()).resolves.toEqual({
      kind: "missing",
      sessionKey: probe.sessionKey,
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
