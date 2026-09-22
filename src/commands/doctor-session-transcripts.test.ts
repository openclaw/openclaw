// Legacy transcript inspection stays advisory; canonical SQLite import owns repairs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectSessionTranscriptHealthIssues,
  sessionTranscriptIssueToHealthFinding,
  sessionTranscriptIssueToRepairEffect,
} from "./doctor-session-transcripts.js";

describe("doctor session transcript health", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-")),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  async function writeTranscript(entries: unknown[]): Promise<string> {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return filePath;
  }

  it("reports affected prompt-rewrite branches without rewriting", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content: [
            "visible ask",
            "",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "secret",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "plain-assistant",
        parentId: "plain-user",
        message: { role: "assistant", content: "answer" },
      },
    ]);
    const original = await fs.readFile(filePath);
    const [issue] = await detectSessionTranscriptHealthIssues({
      sessionDirs: [path.dirname(filePath)],
    });
    expect(issue).toMatchObject({
      filePath,
      broken: true,
      repaired: false,
      originalEntries: 6,
      activeEntries: 3,
      legacyOpenAICodexEntries: 0,
    });
    expect(await fs.readFile(filePath)).toEqual(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["session.jsonl"]);
  });

  it.each(["ENOENT", "EACCES"])(
    "does not label an unreadable file as broken after %s",
    async (code) => {
      const filePath = await writeTranscript([{ type: "session", id: "uninspected" }]);
      const readSpy = vi
        .spyOn(fs, "readFile")
        .mockRejectedValueOnce(Object.assign(new Error("unavailable transcript"), { code }));
      try {
        await expect(
          detectSessionTranscriptHealthIssues({ sessionDirs: [path.dirname(filePath)] }),
        ).resolves.toEqual([]);
      } finally {
        readSpy.mockRestore();
      }
    },
  );

  it("maps affected transcripts to structured findings and dry-run effects", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "legacy-assistant",
        parentId: null,
        message: {
          role: "assistant",
          provider: "openai-codex",
          api: "openai-codex-responses",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    const [issue] = await detectSessionTranscriptHealthIssues({ sessionDirs: [sessionsDir] });

    if (!issue) {
      throw new Error("expected session transcript health issue");
    }
    expect(issue?.filePath).toBe(filePath);
    expect(sessionTranscriptIssueToHealthFinding(issue)).toMatchObject({
      checkId: "core/doctor/session-transcripts",
      severity: "info",
      path: filePath,
      fixHint: expect.stringContaining("openclaw doctor --fix"),
    });
    expect(sessionTranscriptIssueToRepairEffect(issue)).toEqual({
      kind: "file",
      action: "would-rewrite-session-transcript",
      target: filePath,
      dryRunSafe: false,
    });
    expect(await fs.readFile(filePath, "utf-8")).toContain("openai-codex");
  });

  it("detects broken current-version linear transcripts", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-linear", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "runtime-user",
        timestamp: "2026-06-15T00:00:01Z",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "plain-user",
        timestamp: "2026-06-15T00:00:02Z",
        message: { role: "user", content: "visible ask" },
      },
    ]);
    const original = await fs.readFile(filePath);
    const [issue] = await detectSessionTranscriptHealthIssues({
      sessionDirs: [path.dirname(filePath)],
    });
    expect(issue).toMatchObject({
      filePath,
      broken: true,
      repaired: false,
      originalEntries: 3,
      activeEntries: 1,
      legacyOpenAICodexEntries: 0,
    });
    expect(await fs.readFile(filePath)).toEqual(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["session.jsonl"]);
  });

  it("detects the branch selected by a terminal leaf control", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "active-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        parentId: "active-user",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "message",
        id: "side-delivery",
        parentId: "active-assistant",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "metadata",
        id: "plugin-metadata",
        parentId: "runtime-assistant",
        payload: { source: "plugin" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-delivery",
        targetId: "active-assistant",
        appendParentId: "plugin-metadata",
      },
      {
        type: "metadata",
        id: "post-leaf-metadata",
        parentId: "plugin-metadata",
        payload: { phase: "after-leaf" },
      },
    ]);
    const original = await fs.readFile(filePath);
    const [issue] = await detectSessionTranscriptHealthIssues({
      sessionDirs: [path.dirname(filePath)],
    });
    expect(issue).toMatchObject({
      filePath,
      broken: true,
      repaired: false,
      originalEntries: 10,
      activeEntries: 3,
      legacyOpenAICodexEntries: 0,
    });
    expect(await fs.readFile(filePath)).toEqual(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["session.jsonl"]);
  });

  it("classifies parentless visible history with a disjoint append cursor", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-disjoint", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "visible-parent",
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "active-user",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "visible-parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "metadata",
        id: "append-root",
        parentId: null,
        payload: { source: "plugin" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "append-root",
        targetId: "active-assistant",
        appendParentId: "append-root",
      },
    ]);
    const original = await fs.readFile(filePath);
    const [issue] = await detectSessionTranscriptHealthIssues({
      sessionDirs: [path.dirname(filePath)],
    });
    expect(issue).toMatchObject({
      filePath,
      broken: true,
      repaired: false,
      originalEntries: 8,
      activeEntries: 3,
      legacyOpenAICodexEntries: 0,
    });
    expect(await fs.readFile(filePath)).toEqual(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["session.jsonl"]);
  });

  it("classifies the visible branch with an explicit root append cursor", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-root", timestamp: "2026-06-15T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "active-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "active-assistant",
        parentId: "active-user",
        message: { role: "assistant", content: "answer" },
      },
      {
        type: "leaf",
        id: "root-append-control",
        parentId: "runtime-assistant",
        targetId: "active-assistant",
        appendParentId: null,
      },
    ]);
    const original = await fs.readFile(filePath);
    const [issue] = await detectSessionTranscriptHealthIssues({
      sessionDirs: [path.dirname(filePath)],
    });
    expect(issue).toMatchObject({
      filePath,
      broken: true,
      repaired: false,
      originalEntries: 7,
      activeEntries: 3,
      legacyOpenAICodexEntries: 0,
    });
    expect(await fs.readFile(filePath)).toEqual(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["session.jsonl"]);
  });

  it("reports legacy OpenAI Codex metadata without rewriting", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "legacy-assistant",
        parentId: null,
        message: {
          role: "assistant",
          provider: "openai-codex",
          api: "openai-codex-responses",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);
    const original = await fs.readFile(filePath);
    const [issue] = await detectSessionTranscriptHealthIssues({
      sessionDirs: [path.dirname(filePath)],
    });
    expect(issue).toMatchObject({
      filePath,
      broken: true,
      repaired: false,
      originalEntries: 2,
      activeEntries: 1,
      legacyOpenAICodexEntries: 1,
    });
    expect(await fs.readFile(filePath)).toEqual(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["session.jsonl"]);
  });

  it("reports shipped codex metadata without rewriting", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "legacy-assistant",
        parentId: null,
        message: {
          role: "assistant",
          provider: "codex",
          api: "openai-chatgpt-responses",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);
    const original = await fs.readFile(filePath);
    const [issue] = await detectSessionTranscriptHealthIssues({
      sessionDirs: [path.dirname(filePath)],
    });
    expect(issue).toMatchObject({
      filePath,
      broken: true,
      repaired: false,
      originalEntries: 2,
      activeEntries: 1,
      legacyOpenAICodexEntries: 1,
    });
    expect(await fs.readFile(filePath)).toEqual(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(["session.jsonl"]);
  });

  it("ignores ordinary branch history without internal runtime context", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "branch-a",
        parentId: null,
        message: { role: "user", content: "draft A" },
      },
      {
        type: "message",
        id: "branch-b",
        parentId: null,
        message: { role: "user", content: "draft B" },
      },
    ]);
    const original = await fs.readFile(filePath);
    await expect(
      detectSessionTranscriptHealthIssues({ sessionDirs: [path.dirname(filePath)] }),
    ).resolves.toEqual([]);
    expect(await fs.readFile(filePath)).toEqual(original);
  });

  it.each(["{\n", "[]\n", "null\n"])(
    "does not report an unclassifiable transcript %j",
    async (raw) => {
      const filePath = await writeTranscript([]);
      await fs.writeFile(filePath, raw);
      await expect(
        detectSessionTranscriptHealthIssues({ sessionDirs: [path.dirname(filePath)] }),
      ).resolves.toEqual([]);
      expect(await fs.readFile(filePath, "utf8")).toBe(raw);
    },
  );

  it("defers large transcripts without reading their contents", async () => {
    const filePath = await writeTranscript([
      { type: "message", message: { content: "x".repeat(1024 * 1024) } },
    ]);
    const readSpy = vi.spyOn(fs, "readFile");
    try {
      const [issue] = await detectSessionTranscriptHealthIssues({
        sessionDirs: [path.dirname(filePath)],
      });
      expect(issue).toMatchObject({ filePath, deferred: true, broken: false, repaired: false });
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });
});
