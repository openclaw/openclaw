import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guardrail: the "empty post-compaction context" regression came from gateway code appending
// Pi transcript message entries as raw JSONL without `parentId`.
//
// This test is intentionally simple and file-local: if someone reintroduces direct JSONL appends
// against `transcriptPath`, Pi's SessionManager parent chain can break again.
describe("gateway chat transcript writes (guardrail)", () => {
  it("does not append transcript messages via raw fs.appendFileSync(transcriptPath, ...)", () => {
    const chatTs = fileURLToPath(new URL("./chat.ts", import.meta.url));
    const src = fs.readFileSync(chatTs, "utf-8");

    // Disallow raw appends against the resolved transcript path variable.
    // (The transcript header creation via writeFileSync is OK; the bug class is raw message appends.)
    expect(src.includes("fs.appendFileSync(transcriptPath")).toBe(false);

    // Ensure we keep using SessionManager for transcript message appends.
    expect(src).toContain("SessionManager.open(transcriptPath)");
    expect(src).toContain("appendMessage(");
  });
});
