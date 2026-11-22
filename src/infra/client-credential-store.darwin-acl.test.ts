import fs from "node:fs";
import path from "node:path";
import { inspectDarwinAcl, type DarwinAclInspection } from "@openclaw/fs-safe/permissions";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { openClientCredentialCustody } from "./client-credential-store.js";

vi.mock(import("@openclaw/fs-safe/permissions"), async (importOriginal) => ({
  ...(await importOriginal()),
  inspectDarwinAcl: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const cases: [DarwinAclInspection, string][] = [
  [
    { kind: "unknown", reason: "helper-unavailable" },
    "Check that the Node runtime starting the Gateway can load the native ACL helper.",
  ],
  [
    { kind: "present", inheritsToFiles: false, inheritsToDirectories: false },
    "Client credentials require a private directory and file without ACL entries.",
  ],
];

it.each(cases)("reports %j and refuses to create the store", (inspection, diagnostic) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.mocked(inspectDarwinAcl).mockReturnValue(inspection);
  const env = { OPENCLAW_STATE_DIR: dirs.make("client-acl-") };
  const store = resolveClientCredentialStorePath(env);
  fs.mkdirSync(path.dirname(store), { recursive: true, mode: 0o700 });
  expect(() =>
    openClientCredentialCustody(env, { createIfMissing: true, migration: true }),
  ).toThrow(diagnostic);
  expect(fs.existsSync(store)).toBe(false);
});
