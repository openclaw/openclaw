import { describe, expect, it } from "vitest";
import {
  resolveAllowlistMatchByCandidates,
  resolveAllowlistMatchSimple,
} from "./allowlist-match.js";

describe("resolveAllowlistMatchByCandidates", () => {
  it("invalidates cache when allowlist contents change but length stays the same", () => {
    const allowList = ["alice", "bob"];
    const candidates = [{ value: "alice", source: "id" as const }];
    expect(resolveAllowlistMatchByCandidates({ allowList, candidates }).allowed).toBe(true);

    allowList[0] = "carol";
    expect(resolveAllowlistMatchByCandidates({ allowList, candidates }).allowed).toBe(false);
    expect(
      resolveAllowlistMatchByCandidates({
        allowList,
        candidates: [{ value: "carol", source: "id" as const }],
      }).allowed,
    ).toBe(true);
  });
});

describe("resolveAllowlistMatchSimple", () => {
  it("invalidates simple allowlist cache when entries mutate at same length", () => {
    const allowFrom: Array<string | number> = ["user-1", "*"];
    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "someone-else" }).allowed).toBe(true);

    allowFrom[1] = "user-2";
    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "someone-else" }).allowed).toBe(
      false,
    );
    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "user-2" }).allowed).toBe(true);
  });
});
