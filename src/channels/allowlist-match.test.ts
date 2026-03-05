import { describe, expect, it } from "vitest";
import {
  resolveAllowlistMatchByCandidates,
  resolveAllowlistMatchSimple,
} from "./allowlist-match.js";

describe("resolveAllowlistMatchByCandidates", () => {
  it("refreshes cached allowList sets when an array is mutated in-place", () => {
    const allowList = ["alice"];

    expect(
      resolveAllowlistMatchByCandidates({
        allowList,
        candidates: [{ value: "alice", source: "id" }],
      }),
    ).toEqual({
      allowed: true,
      matchKey: "alice",
      matchSource: "id",
    });

    allowList[0] = "bob";

    expect(
      resolveAllowlistMatchByCandidates({
        allowList,
        candidates: [{ value: "alice", source: "id" }],
      }),
    ).toEqual({ allowed: false });

    expect(
      resolveAllowlistMatchByCandidates({
        allowList,
        candidates: [{ value: "bob", source: "id" }],
      }),
    ).toEqual({
      allowed: true,
      matchKey: "bob",
      matchSource: "id",
    });
  });
});

describe("resolveAllowlistMatchSimple", () => {
  it("refreshes cached normalized sets when allowFrom mutates with same length", () => {
    const allowFrom: Array<string | number> = ["alice"];

    expect(
      resolveAllowlistMatchSimple({
        allowFrom,
        senderId: "alice",
      }),
    ).toEqual({
      allowed: true,
      matchKey: "alice",
      matchSource: "id",
    });

    allowFrom[0] = "bob";

    expect(
      resolveAllowlistMatchSimple({
        allowFrom,
        senderId: "alice",
      }),
    ).toEqual({ allowed: false });

    expect(
      resolveAllowlistMatchSimple({
        allowFrom,
        senderId: "bob",
      }),
    ).toEqual({
      allowed: true,
      matchKey: "bob",
      matchSource: "id",
    });
  });
});
