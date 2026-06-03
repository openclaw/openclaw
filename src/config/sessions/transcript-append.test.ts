import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import { writeJsonlLines, writeJsonlLinesAtomic } from "./transcript-jsonl.js";

const readLoggingConfig = vi.hoisted(() => vi.fn());

vi.mock("../../logging/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/config.js")>();
  return {
    ...actual,
    readLoggingConfig,
  };
});

// A legacy "linear" transcript: a session header plus message entries that carry
// no parentId. The next append triggers migrateLinearTranscriptToParentLinked,
// which rewrites the whole file in place — the path under test.
function linearTranscript(): string {
  return `${[
    JSON.stringify({ type: "session", version: 1, sessionId: "s1", cwd: "/tmp/cwd" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: [{ type: "text", text: "first" }] },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
  ].join("\n")}\n`;
}

function readEntries(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("writeJsonlLinesAtomic", () => {
  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-atomic-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes byte-identical content and mode to the non-atomic writeJsonlLines", async () => {
    // Verbatim-preserved non-JSON line included to prove the migration's
    // pass-through lines are not reserialized differently by the atomic path.
    const lines = ['{"type":"session","version":3}', '{"id":"a","parentId":null}', "corrupt line"];
    const plain = path.join(dir, "plain.jsonl");
    const atomic = path.join(dir, "atomic.jsonl");

    await writeJsonlLines(plain, lines, { mode: 0o600 });
    await writeJsonlLinesAtomic(atomic, lines, { mode: 0o600 });

    expect(fs.readFileSync(atomic)).toEqual(fs.readFileSync(plain));
    expect(fs.statSync(atomic).mode & 0o777).toBe(0o600);
    expect(fs.statSync(plain).mode & 0o777).toBe(0o600);
  });

  it("leaves an existing file untouched and drops the temp when the rename fails", async () => {
    const target = path.join(dir, "existing.jsonl");
    const original = "untouched original\n";
    fs.writeFileSync(target, original, { mode: 0o600 });
    const renameSpy = vi
      .spyOn(fsPromises, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));

    await expect(writeJsonlLinesAtomic(target, ["new content"], { mode: 0o600 })).rejects.toThrow();

    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(target, "utf-8")).toBe(original);
    // No partial/temp sibling left behind: only the original file remains.
    expect(fs.readdirSync(dir)).toEqual(["existing.jsonl"]);
  });
});

describe("appendSessionTranscriptMessage - linear migration atomicity", () => {
  const fixture = useTempSessionsFixture("transcript-migrate-test-");

  beforeEach(() => {
    readLoggingConfig.mockReset();
    readLoggingConfig.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedLinear(sessionId: string): string {
    const file = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.writeFileSync(file, linearTranscript(), { mode: 0o600 });
    return file;
  }

  it("migrates a linear transcript to parent-linked form on append", async () => {
    const file = seedLinear("migrate-success");

    await appendSessionTranscriptMessage({
      transcriptPath: file,
      message: { role: "user", content: [{ type: "text", text: "third" }] },
      config: { logging: { redactSensitive: "off" } },
    });

    const entries = readEntries(file);
    const [header, m1, m2, appended] = entries;
    expect(header.type).toBe("session");
    expect(header.version).toBe(3); // header bumped to CURRENT_SESSION_VERSION
    expect(m1).toMatchObject({ id: "m1", parentId: null });
    expect(m2).toMatchObject({ id: "m2", parentId: "m1" });
    expect(appended).toMatchObject({ type: "message", parentId: "m2" });
    expect(entries).toHaveLength(4);
  });

  it("keeps the original transcript intact and leaves no temp when the migration write fails", async () => {
    const file = seedLinear("migrate-fail");
    const original = fs.readFileSync(file, "utf-8");
    const before = fs.readdirSync(fixture.sessionsDir()).toSorted();
    vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(
      Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }),
    );

    await expect(
      appendSessionTranscriptMessage({
        transcriptPath: file,
        message: { role: "user", content: [{ type: "text", text: "third" }] },
        config: { logging: { redactSensitive: "off" } },
      }),
    ).rejects.toThrow();

    // Old transcript not lost, no partial rewrite committed, no leftover temp.
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
    expect(fs.readdirSync(fixture.sessionsDir()).toSorted()).toEqual(before);
  });

  it("releases the lock so a retry after an injected failure still completes the migration", async () => {
    const file = seedLinear("migrate-retry");
    vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(
      Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }),
    );

    await expect(
      appendSessionTranscriptMessage({
        transcriptPath: file,
        message: { role: "user", content: [{ type: "text", text: "third" }] },
        config: { logging: { redactSensitive: "off" } },
      }),
    ).rejects.toThrow();

    // rename now succeeds; the next append must acquire the lock (proving it was
    // released) and finish the migration the failed attempt rolled back.
    const result = await appendSessionTranscriptMessage({
      transcriptPath: file,
      message: { role: "user", content: [{ type: "text", text: "third-retry" }] },
      config: { logging: { redactSensitive: "off" } },
    });

    expect(result.appended).toBe(true);
    const entries = readEntries(file);
    expect(entries[0]).toMatchObject({ type: "session", version: 3 });
    expect(entries[1]).toMatchObject({ id: "m1", parentId: null });
    expect(entries.at(-1)).toMatchObject({ type: "message", parentId: "m2" });
    expect(entries).toHaveLength(4);
  });
});
