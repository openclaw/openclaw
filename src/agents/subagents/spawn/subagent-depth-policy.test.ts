import { expect, it } from "vitest";
import { mergeSessionEntry, type SessionEntry } from "../../../config/sessions/types.js";
import {
  getSubagentDepthFromEntryLookup,
  isSubagentSessionFromEntry,
} from "./subagent-depth-policy.js";

const parent = "agent:main:main";
const child = "agent:main:dashboard:child";
const lineage: SessionEntry = {
  sessionId: "child-id",
  updatedAt: 1,
  spawnedBy: parent,
  spawnDepth: 1,
  createdVia: "spawn",
};

it("separates independent conversation identity from admission depth", () => {
  const independent = { ...lineage, createdIndependently: true as const };
  expect(isSubagentSessionFromEntry(child, independent)).toBe(false);
  expect(getSubagentDepthFromEntryLookup(child, () => independent)).toBe(1);
  expect(
    getSubagentDepthFromEntryLookup(child, (key) =>
      key === child ? { ...independent, spawnDepth: undefined } : { spawnDepth: 2 },
    ),
  ).toBe(3);
  expect(isSubagentSessionFromEntry(child, lineage)).toBe(true);
  expect(isSubagentSessionFromEntry(child, { ...lineage, spawnDepth: undefined })).toBe(true);
  expect(isSubagentSessionFromEntry("agent:main:subagent:child", undefined)).toBe(true);
  expect(isSubagentSessionFromEntry(child, { spawnDepth: 0 })).toBe(false);
  expect(
    isSubagentSessionFromEntry(
      child,
      { spawnDepth: 0, parentSessionKey: parent },
      { runtime: "acpx" },
    ),
  ).toBe(true);
});

it("retains creation intent across session rotation without stamping older entries", () => {
  expect(
    mergeSessionEntry(
      { ...lineage, createdIndependently: true },
      {
        sessionId: "rotated",
        createdIndependently: undefined,
      },
    ),
  ).toMatchObject({ sessionId: "rotated", createdIndependently: true, spawnDepth: 1 });
  expect(
    mergeSessionEntry(lineage, { createdIndependently: true }).createdIndependently,
  ).toBeUndefined();
});
