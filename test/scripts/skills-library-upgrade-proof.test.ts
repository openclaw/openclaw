import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runStablePackageCommand } from "../helpers/skills-library-upgrade-proof.test-support.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each([
  {
    phase: "resolver" as const,
    output:
      "OpenClaw package tarball integrity failed:\ndist/proof.mjs imports missing dist/companion.cjs",
    code: null,
    classification: "tarball-missing-relative-import",
  },
  {
    phase: "install" as const,
    output: "npm error code E401",
    code: "E401",
    classification: "known-npm-or-runtime-code",
  },
])(
  "reports safe $phase failure facts without publishing private output",
  async ({ phase, output, code, classification }) => {
    const root = tempDirs.make("stable-command-proof-");
    const secret = randomUUID();
    const failure = await runStablePackageCommand(
      phase,
      "2026.11.1",
      process.execPath,
      [
        "-e",
        "process.stderr.write(process.argv[1]); process.exit(23)",
        output + "\nAuthorization: " + secret,
      ],
      root,
      10000,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected an observable command failure");
    }
    const prefix = "Owned stable-package command failed: ";
    expect(failure.message.startsWith(prefix)).toBe(true);
    expect(JSON.parse(failure.message.slice(prefix.length))).toEqual({
      phase,
      version: "2026.11.1",
      status: 23,
      exit: 23,
      signal: null,
      code,
      classification,
    });
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain("Authorization");
    expect(readFileSync(path.join(root, "commands.private.log"), "utf8")).toContain(secret);
  },
);
