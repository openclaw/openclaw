import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each(["install-cli.sh", "install.sh"])(
  "%s resolves release tags without leaking credentials or losing history",
  (installer) => {
    const result = spawnSync(
      "/bin/bash",
      ["scripts/test-install-git-ref.sh", `scripts/${installer}`],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
  60_000,
);
