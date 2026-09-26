// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ConfigFormArrayIdentity } from "./config-form-array-identity.ts";

describe("config form array row identity", () => {
  it("keeps appended primitive identities unique after an equal row is removed", () => {
    const initial = ["same", "same"];
    const owner = new ConfigFormArrayIdentity();
    const initialIdentities = owner.read(initial);
    const afterRemoval = ["same"];
    owner.patch(afterRemoval, initialIdentities.slice(1), () => true);

    const afterAppend = ["same", "same"];
    owner.patch(afterAppend, [...owner.read(afterRemoval), Symbol("new-row")], () => true);
    const appendedIdentities = owner.read(afterAppend);

    expect(new Set(appendedIdentities).size).toBe(appendedIdentities.length);
    expect(appendedIdentities[0]).toBe(initialIdentities[1]);
  });

  it("removes row metadata from rejected candidate arrays", () => {
    const owner = new ConfigFormArrayIdentity();
    const original = ["same"];
    const originalIdentity = owner.read(original)[0];
    const candidate = ["same"];
    const rejectedIdentity = Symbol("rejected-row");
    owner.patch(candidate, [rejectedIdentity], () => {
      owner.read(candidate);
      return false;
    });

    expect(owner.read(structuredClone(original))[0]).toBe(originalIdentity);
    expect(owner.read(candidate)[0]).not.toBe(rejectedIdentity);
  });

  it("matches cloned and reordered rows once, including equal occurrences", () => {
    const owner = new ConfigFormArrayIdentity();
    const first = [{ name: "first" }, { name: "same" }, { name: "same" }];
    const keys = owner.read(first);
    const reordered = structuredClone([first[1], first[0], first[2]]);

    expect(owner.read(reordered)).toEqual([keys[1], keys[0], keys[2]]);
    expect(owner.read(structuredClone(reordered))).toEqual([keys[1], keys[0], keys[2]]);
  });

  it("does not give an unchanged row's identity to a new equal value", () => {
    const owner = new ConfigFormArrayIdentity();
    const keys = owner.read(["first", "same"]);
    const next = owner.read(["same", "same"]);

    expect(next[1]).toBe(keys[1]);
    expect(next[0]).not.toBe(keys[1]);
  });
});
