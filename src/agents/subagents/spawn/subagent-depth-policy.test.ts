import { expect, it } from "vitest";
import { mergeSessionEntry, type SessionEntry } from "../../../config/sessions/types.js";
import {
  getSubagentDepthFromEntryLookup,
  isPrivateSubagentCoordinationFromEntry,
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
  expect(isPrivateSubagentCoordinationFromEntry(child, independent)).toBe(false);
  expect(isSubagentSessionFromEntry(child, independent)).toBe(true);
  expect(getSubagentDepthFromEntryLookup(child, () => independent)).toBe(1);
  expect(
    getSubagentDepthFromEntryLookup(child, (key) =>
      key === child ? { ...independent, spawnDepth: undefined } : { spawnDepth: 2 },
    ),
  ).toBe(3);
  expect(isPrivateSubagentCoordinationFromEntry(child, lineage)).toBe(true);
  expect(isPrivateSubagentCoordinationFromEntry(child, { ...lineage, spawnDepth: undefined })).toBe(
    true,
  );
  expect(isPrivateSubagentCoordinationFromEntry("agent:main:subagent:child", undefined)).toBe(true);
  const root = { sessionId: "root-id", updatedAt: 1, spawnDepth: 0 };
  expect(isPrivateSubagentCoordinationFromEntry(child, root)).toBe(false);
  expect(
    isPrivateSubagentCoordinationFromEntry(
      child,
      { ...root, parentSessionKey: parent },
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
