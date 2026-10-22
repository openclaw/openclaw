import { beforeAll, expect, test } from "vitest";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { expectPatchOk, MAIN_SESSION_KEY, runPatch } from "./sessions-patch.test-support.js";

beforeAll(async () => {
  await prepareSharedAuthStoreOwnership();
});

test.each([
  { field: "responseUsage", value: "off" },
  { field: "reasoningLevel", value: "off" },
  { field: "verboseLevel", value: "full" },
  { field: "traceLevel", value: "raw" },
  { field: "elevatedLevel", value: "off" },
  { field: "elevatedLevel", value: "on" },
] as const)("persists explicit $field=$value", async ({ field, value }) => {
  const entry = expectPatchOk(await runPatch({ patch: { key: MAIN_SESSION_KEY, [field]: value } }));
  // Explicit off values must survive configured defaults, including messages.responseUsage.
  expect(entry[field]).toBe(value);
});
