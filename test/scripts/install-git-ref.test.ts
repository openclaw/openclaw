import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("resolves shallow release tags after transient Git errors without leaking credentials", () => {
  const result = spawnSync(
    "/bin/bash",
    ["scripts/test-install-git-ref.sh", "scripts/install-cli.sh", "scripts/install.sh"],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);
