import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveUpdateCandidateAdmissionTimeoutMs } from "./update-candidate-snapshot.js";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
it("sizes candidate admission to measured state within the update step deadline", async () => {
  const stateDir = await fs.realpath(tempDirs.make("admission-budget-"));
  const database = path.join(stateDir, "state/openclaw.sqlite");
  await fs.mkdir(path.dirname(database), { recursive: true });
  await fs.writeFile(database, "");
  await fs.truncate(database, 3 * 1024 ** 3);
  const budget = (stepTimeoutMs: number) =>
    resolveUpdateCandidateAdmissionTimeoutMs({
      config: {},
      stateDir,
      env: { OPENCLAW_STATE_DIR: stateDir },
      stepTimeoutMs,
    });
  expect(await budget(Number.MAX_SAFE_INTEGER)).toBeGreaterThan(300_000);
  expect(await budget(1_800_000)).toBe(1_800_000);
});
