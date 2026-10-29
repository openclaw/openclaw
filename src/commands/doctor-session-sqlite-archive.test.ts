/** Archive naming must stay inside one filesystem name component (NAME_MAX). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planSessionJsonlArchiveMove } from "./doctor-session-sqlite-archive.js";

const roots: string[] = [];

function makeCase(fileName: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-"));
  roots.push(root);
  const sessions = path.join(root, "agents", "atlas", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const source = path.join(sessions, fileName);
  fs.writeFileSync(source, "{}");
  return { source, target: { storePath: path.join(sessions, "sessions.sqlite") } as never };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("planSessionJsonlArchiveMove naming", () => {
  it("bounds a Matrix thread archive name below the component limit", () => {
    const matrixThreadKey = `agent_atlas_matrix_channel_room_matrix.example.org_thread_$speaker_${"0".repeat(
      160,
    )}_3Aheartbeat`;
    const { source, target } = makeCase(
      `agent_atlas_matrix_channel_room_matrix.example.org_thread_${"t".repeat(120)}.trajectory.jsonl`,
    );

    const move = planSessionJsonlArchiveMove({
      archiveKey: matrixThreadKey,
      kind: "trajectory",
      sourcePathRaw: source,
      target,
      sessionKey: matrixThreadKey,
    });

    const name = path.basename(move.archivePath);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(240);
    expect(name.includes(".jsonl.")).toBe(true);
    expect(name).toMatch(/\.imported-\d+$/);
    // The full identity stays in metadata even though the name is truncated.
    expect(move.sessionKey).toBe(matrixThreadKey);
  });

  it("keeps distinct long keys collision-resistant", () => {
    const { source, target } = makeCase("agent_atlas_long.trajectory.jsonl");
    const first = planSessionJsonlArchiveMove({
      archiveKey: `${"a".repeat(260)}-one`,
      kind: "trajectory",
      sourcePathRaw: source,
      target,
    });
    const second = planSessionJsonlArchiveMove({
      archiveKey: `${"a".repeat(260)}-two`,
      kind: "trajectory",
      sourcePathRaw: source,
      target,
    });

    expect(path.basename(first.archivePath)).not.toBe(path.basename(second.archivePath));
  });

  it("keeps ordinary names readable", () => {
    const { source, target } = makeCase("agent_main_session.trajectory.jsonl");

    const move = planSessionJsonlArchiveMove({
      archiveKey: "agent:main:session",
      kind: "trajectory",
      sourcePathRaw: source,
      target,
    });

    const name = path.basename(move.archivePath);
    expect(name).toContain("agent_main_session");
    expect(name).toContain("agent_main_session.trajectory.jsonl");
  });
});
