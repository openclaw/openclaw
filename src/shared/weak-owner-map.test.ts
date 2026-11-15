import { expect, it } from "vitest";
import { getOrCreateWeakOwnerMap } from "./weak-owner-map.js";

it("reuses only the exact owner's map and creates a fresh map after its slot is retired", () => {
  const owners = new WeakMap<object, Map<string, string>>();
  const first = {};
  const second = {};
  const firstMap = getOrCreateWeakOwnerMap(owners, first);
  firstMap.set("key", "first");
  const secondMap = getOrCreateWeakOwnerMap(owners, second);
  secondMap.set("key", "second");
  expect(getOrCreateWeakOwnerMap(owners, first)).toBe(firstMap);
  expect(firstMap.get("key")).toBe("first");
  expect(secondMap.get("key")).toBe("second");
  owners.delete(first);
  expect(getOrCreateWeakOwnerMap(owners, first).size).toBe(0);
  expect(getOrCreateWeakOwnerMap(owners, second)).toBe(secondMap);
});
