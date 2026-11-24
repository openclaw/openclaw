import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { toPublicUpdateRun } from "./update-run-record.js";
import * as windowsUser from "./windows-user-sid.js";

const dirs = createTempDirTracker();
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  dirs.cleanup();
});

it("retains the launching SID through history, reentry, and public projection", async () => {
  const root = dirs.make("update-windows-user-");
  const options = {
    env: { HOME: root, USERPROFILE: root, OPENCLAW_STATE_DIR: path.join(root, "state") },
  };
  const sid = vi.spyOn(windowsUser, "readWindowsUserSid").mockReturnValue("S-1-5-21-100");
  const created = createUpdateRun({ trigger: "cli" }, options);
  expect(created.origin.windowsUserSid).toBe("S-1-5-21-100");
  await closeOpenClawStateDatabaseAsync();
  expect(getUpdateRun(created.runId, options)?.origin.windowsUserSid).toBe("S-1-5-21-100");

  sid.mockReturnValue("S-1-5-21-200");
  const existing = createUpdateRun({ trigger: "cli", runId: created.runId }, options);
  expect(existing.origin.windowsUserSid).toBe("S-1-5-21-100");
  expect(toPublicUpdateRun(existing).origin).not.toHaveProperty("windowsUserSid");
});
