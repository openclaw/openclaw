/**
 * Tests for sessions.compact — specifically the session header preservation
 * fix: after compaction the session header line (type:"session") must remain
 * as the first line so loadEntriesFromFile can validate the transcript.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayRequestContext } from "./types.js";
import { sessionsHandlers } from "./sessions.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  updateSessionStore: vi.fn(),
  resolveGatewaySessionStoreTarget: vi.fn(),
  resolveSessionTranscriptCandidates: vi.fn(),
  archiveFileOnDisk: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return { ...actual, loadConfig: () => ({}) };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionStoreTarget: mocks.resolveGatewaySessionStoreTarget,
    resolveSessionTranscriptCandidates: mocks.resolveSessionTranscriptCandidates,
    archiveFileOnDisk: mocks.archiveFileOnDisk,
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mocks.existsSync,
      readFileSync: mocks.readFileSync,
      writeFileSync: mocks.writeFileSync,
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHeader(sessionId = "sess-abc"): string {
  return JSON.stringify({ type: "session", id: sessionId, v: 1 });
}

function makeBody(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({ type: "message", seq: i + 1, content: `msg-${i + 1}` }),
  );
}

const noop = () => false;

async function callCompact(params: Record<string, unknown>) {
  const respond = vi.fn();
  await sessionsHandlers["sessions.compact"]({
    params,
    respond,
    context: {} as GatewayRequestContext,
    client: null,
    req: { id: "req-1", type: "req", method: "sessions.compact" },
    isWebchatConnect: noop,
  });
  return respond;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mocks.resolveGatewaySessionStoreTarget.mockReturnValue({
    canonicalKey: "agent:main:main",
    storeKeys: ["agent:main:main"],
    storePath: "/fake/sessions.json",
    agentId: "main",
  });
  mocks.updateSessionStore.mockResolvedValue({
    entry: { sessionId: "sess-abc" },
    primaryKey: "agent:main:main",
  });
  mocks.archiveFileOnDisk.mockReturnValue("/fake/sessions/sess-abc.jsonl.bak");
  mocks.existsSync.mockReturnValue(true);
  mocks.resolveSessionTranscriptCandidates.mockReturnValue(["/fake/sessions/sess-abc.jsonl"]);
  mocks.writeFileSync.mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sessions.compact — session header preservation", () => {
  it("preserves session header when file has more lines than maxLines", async () => {
    const header = makeHeader();
    const body = makeBody(10);
    const lines = [header, ...body];
    mocks.readFileSync.mockReturnValue(lines.join("\n") + "\n");

    const respond = await callCompact({ key: "agent:main:main", maxLines: 5 });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ compacted: true }),
      undefined,
    );

    const written = mocks.writeFileSync.mock.calls[0]?.[1] as string;
    const writtenLines = written.trim().split("\n");

    // First line must be the original session header
    expect(writtenLines[0]).toBe(header);
    // Total lines: 1 header + 5 body = 6
    expect(writtenLines).toHaveLength(6);
    // Body lines are the last 5 of the original body (newest first)
    expect(writtenLines.slice(1)).toEqual(body.slice(-5));
  });

  it("does not compact when line count is within maxLines", async () => {
    const header = makeHeader();
    const body = makeBody(3);
    mocks.readFileSync.mockReturnValue([header, ...body].join("\n") + "\n");

    const respond = await callCompact({ key: "agent:main:main", maxLines: 10 });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ compacted: false }),
      undefined,
    );
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("falls back gracefully when first line is not a session header", async () => {
    // Some older or malformed transcripts may not have a session header
    const body = makeBody(10);
    mocks.readFileSync.mockReturnValue(body.join("\n") + "\n");

    const respond = await callCompact({ key: "agent:main:main", maxLines: 5 });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ compacted: true }),
      undefined,
    );

    const written = mocks.writeFileSync.mock.calls[0]?.[1] as string;
    const writtenLines = written.trim().split("\n");

    // No session header → just keep last maxLines body entries
    expect(writtenLines).toHaveLength(5);
    expect(writtenLines).toEqual(body.slice(-5));
  });

  it("uses default maxLines of 400 when not provided", async () => {
    const header = makeHeader();
    const body = makeBody(500);
    mocks.readFileSync.mockReturnValue([header, ...body].join("\n") + "\n");

    const respond = await callCompact({ key: "agent:main:main" });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ compacted: true }),
      undefined,
    );

    const written = mocks.writeFileSync.mock.calls[0]?.[1] as string;
    const writtenLines = written.trim().split("\n");

    // 1 header + 400 body lines
    expect(writtenLines).toHaveLength(401);
    expect(writtenLines[0]).toBe(header);
  });
});
