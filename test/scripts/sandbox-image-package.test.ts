import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships the default sandbox builder and its full runtime dependency closure", () => {
  const { files } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { files: string[] };
  // Independent installed-package contract, including the watchdog used on macOS
  // without coreutils and the optional build-warning relay.
  for (const file of [
    "scripts/sandbox-setup.sh",
    "scripts/docker/sandbox/Dockerfile",
    "scripts/lib/docker-build.sh",
    "scripts/lib/docker-e2e-logs.sh",
    "scripts/lib/docker-e2e-container.sh",
    "scripts/lib/docker-e2e-resource-diagnostics.sh",
    "scripts/lib/docker-e2e-watchdog.mjs",
    "scripts/lib/direct-run.mjs",
    "scripts/relay-build-limit-warnings.mts",
    "scripts/lib/check-limits.mts",
    "scripts/lib/release-context.mjs",
    "scripts/lib/release-version.mjs",
  ]) {
    expect(files, `npm package must include ${file}`).toContain(file);
  }
});
