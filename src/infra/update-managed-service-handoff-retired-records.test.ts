import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: () => fixture.root }));

let store: ReturnType<typeof createManagedHandoffLeaseStore>;
let unrelatedConfig: string;

function databasePath() {
  return path.join(fixture.root, "managed-update-handoffs.sqlite");
}

/** Seed a foreign row the way an older build left one behind in the shared tmp store. */
function seedRow(installRoot: string, owner: string, payload: string) {
  const db = new DatabaseSync(databasePath());
  try {
    db.prepare(
      "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run(installRoot, owner, payload, Date.now());
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-retired-")));
  fs.chmodSync(fixture.root, 0o700);
  unrelatedConfig = path.join(fixture.root, "openclaw.json");
  fs.writeFileSync(unrelatedConfig, "{}");
  store = createManagedHandoffLeaseStore();
  // Acquiring one lease creates the shared table every install root writes into.
  const acquired = store.acquire(path.join(fixture.root, "install"), "owner", { kind: "update" });
  expect(acquired.kind).toBe("acquired");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

it("keeps an unrelated source usable beside a retired lease record", () => {
  seedRow(
    path.join(fixture.root, "legacy-install"),
    "systemd-boundary",
    JSON.stringify({ version: 1, pid: 4242, startIdentity: "1788399465" }),
  );

  expect(() => store.assertSourceUnborrowed(unrelatedConfig)).not.toThrow();
});

it("still refuses an unrelated source beside an undecodable lease record", () => {
  seedRow(
    path.join(fixture.root, "unknown-install"),
    "unknown",
    JSON.stringify({ version: 9, borrows: "something this build cannot read" }),
  );

  expect(() => store.assertSourceUnborrowed(unrelatedConfig)).toThrow(
    /existing managed handoff lease is incompatible/u,
  );
});
