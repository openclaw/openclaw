import { beforeAll, expect, test } from "vitest";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import {
  expectPatchError,
  expectPatchOk,
  MAIN_SESSION_KEY,
  mainStoreEntry,
  runPatch,
} from "./sessions-patch.test-support.js";

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

test.each([
  { value: undefined, expected: "node" },
  { value: null, expected: undefined },
  { value: " GATEWAY ", expected: "gateway" },
])("projects execHost=$value without changing the node binding", async ({ value, expected }) => {
  const store = mainStoreEntry({ execHost: "node", execNode: "worker", execCwd: "/workspace" });
  const entry = expectPatchOk(
    await runPatch({
      store,
      patch: { key: MAIN_SESSION_KEY, execHost: value, execNode: " worker " },
    }),
  );
  expect(entry.execHost).toBe(expected);
  expect(entry.execNode).toBe("worker");
  expect(entry.execCwd).toBe("/workspace");
});

test.each([
  { patch: {}, expected: "native-fixture" },
  { patch: { nativeRuntimeConsent: "replacement" }, expected: "replacement" },
  { patch: { nativeRuntimeConsent: null }, expected: undefined },
  { patch: { permissionMode: "workspace" }, expected: undefined },
  { patch: { permissionMode: null }, expected: undefined },
  { patch: { sandboxMode: null }, expected: undefined },
] satisfies { patch: Partial<SessionsPatchParams>; expected: string | undefined }[])(
  "retains native consent only with full permissions and sandbox off: $patch",
  async ({ patch, expected }) => {
    const store = mainStoreEntry({
      permissionMode: "full",
      sandboxMode: "off",
      nativeRuntimeConsent: "native-fixture",
    });
    const entry = expectPatchOk(
      await runPatch({ store, patch: { key: MAIN_SESSION_KEY, ...patch } }),
    );
    expect(entry.nativeRuntimeConsent).toBe(expected);
  },
);

test.each([
  { patch: { elevatedLevel: "maybe", execHost: "edge" }, error: "invalid elevatedLevel" },
  { patch: { execHost: "edge", execNode: " " }, error: "invalid execHost" },
  { patch: { execNode: " ", sandboxMode: "off" }, error: "invalid execNode: empty" },
  {
    patch: { sandboxMode: "off", permissionMode: "full" },
    error: "This session requires a sandbox and cannot run without one.",
  },
] satisfies { patch: Partial<SessionsPatchParams>; error: string }[])(
  "rejects execution preferences in order without applying partial changes: $patch",
  async ({ patch, error }) => {
    const store = mainStoreEntry({ sandbox: "required", permissionMode: "workspace" });
    const before = structuredClone(store);
    expectPatchError(await runPatch({ store, patch: { key: MAIN_SESSION_KEY, ...patch } }), error);
    expect(store).toEqual(before);
  },
);
