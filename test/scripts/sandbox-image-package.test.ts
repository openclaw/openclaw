import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("ships only the standalone sandbox builder and Dockerfile without test infrastructure", () => {
  const { files } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { files: string[] };
  expect(
    files
      .filter(
        (file) => file.startsWith("scripts/sandbox-") || file.startsWith("scripts/docker/sandbox/"),
      )
      .toSorted(),
  ).toEqual(["scripts/docker/sandbox/Dockerfile", "scripts/sandbox-image-build.sh"]);
  for (const file of [
    "scripts/sandbox-setup.sh",
    "scripts/lib/docker-build.sh",
    "scripts/lib/docker-e2e-logs.sh",
    "scripts/lib/docker-e2e-container.sh",
    "scripts/lib/docker-e2e-resource-diagnostics.sh",
    "scripts/lib/docker-e2e-watchdog.mjs",
    "scripts/relay-build-limit-warnings.mts",
    "scripts/lib/check-limits.mts",
    "scripts/lib/release-context.mjs",
    "scripts/lib/release-version.mjs",
  ]) {
    expect(files, `npm package must not include ${file}`).not.toContain(file);
  }
});

it.skipIf(process.platform === "win32")(
  "builds from only the installed sandbox files with an unrelated working directory",
  () => {
    const root = tempDirs.make("sandbox-package-");
    const installed = path.join(root, "installed package");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    for (const file of ["scripts/sandbox-image-build.sh", "scripts/docker/sandbox/Dockerfile"]) {
      const target = path.join(installed, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(new URL(`../../${file}`, import.meta.url), target);
    }
    // Capture the external Docker boundary without launching a container or builder.
    writeFileSync(path.join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$DOCKER_BUILDKIT" "$@"\n', {
      mode: 0o755,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    delete env.OPENCLAW_SANDBOX_IMAGE;
    const result = spawnSync("bash", [path.join(installed, "scripts/sandbox-image-build.sh")], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "1",
      "build",
      "--progress=plain",
      "-t",
      "openclaw-sandbox:trixie-slim",
      "-f",
      path.join(installed, "scripts/docker/sandbox/Dockerfile"),
      path.join(installed, "scripts/docker/sandbox"),
    ]);
  },
);
