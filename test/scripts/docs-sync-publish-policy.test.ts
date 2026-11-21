import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "publishes docs only through a checked PR with a real squash receipt",
  () => {
    const result = spawnSync(
      "python3",
      [path.join(import.meta.dirname, "fixtures/docs-sync-publish-policy.py"), "-v"],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
  65_000,
);
