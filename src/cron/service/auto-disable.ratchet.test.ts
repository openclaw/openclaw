import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { listDirectoryTreeStrictSync } from "../../infra/directory-walk.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
// Only the stop owner turns a job off for the scheduler; operator patches assign
// the caller's value (`job.enabled = patch.enabled`) and never a literal false.
const OWNER = "src/cron/service/auto-disable.ts";
const STRAY_STOP =
  /^\s*[\w.]+\.enabled\s*=\s*false\s*;|(?:update|updateWithPrecondition)\([^)]*\{\s*enabled:\s*false\s*\}/mu;

it("keeps every scheduler stop behind autoDisableCronJob", () => {
  const files = ["src/cron", "src/gateway"].flatMap((dir) =>
    listDirectoryTreeStrictSync(path.join(repoRoot, dir))
      .map((entry) => path.join(dir, entry.relativePath))
      .filter(
        (file) =>
          file.endsWith(".ts") && !/\.test(?:-[\w-]+)?\.ts$|test-support|test-helpers/u.test(file),
      ),
  );
  const stray = files.filter(
    (file) => file !== OWNER && STRAY_STOP.test(fs.readFileSync(path.join(repoRoot, file), "utf8")),
  );
  expect(files).toContain(OWNER);
  expect(stray).toEqual([]);
});
