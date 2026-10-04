import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.9.7";
const pending = {
  name: "@openclaw/example",
  version,
  publicationStatus: "pending",
  attemptId: "attempt-1",
};

function render(
  records: unknown[],
  reason = "Parent failed after staging",
  releaseVersion = version,
  separator: string[] = [],
) {
  const directory = directories.make("clawhub-recovery-");
  const paths = records.map((record, index) => {
    const path = join(directory, `${index}.json`);
    writeFileSync(path, JSON.stringify(record));
    return path;
  });
  const result = spawnSync(
    process.execPath,
    [
      "scripts/plugin-clawhub-recovery.mjs",
      ...separator,
      "--version",
      releaseVersion,
      "--reason",
      reason,
      "--clawhub-source",
      join(directory, "source checkout"),
      ...paths,
    ],
    { encoding: "utf8" },
  );
  return { directory, ...result };
}

describe("ClawHub staged publication recovery commands", () => {
  it("rejects a version that could escape the generated comment", () => {
    const releaseVersion = "2026.9.7\necho injected";
    const result = render([{ ...pending, version: releaseVersion }], "Recovery", releaseVersion);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("preserves exact attempts and safely quotes commands while skipping published packages", () => {
    const reason = "Parent's failure; $(printf INJECTED)";
    const result = render(
      [
        pending,
        { ...pending, name: "@openclaw/done", publicationStatus: "published" },
        {
          ...pending,
          name: "@openclaw/failed",
          publicationStatus: "failed",
          attemptId: "attempt-2",
        },
      ],
      reason,
      version,
      ["--"],
    );
    expect(result.status, result.stderr).toBe(0);
    const bun = join(result.directory, "bun");
    writeFileSync(
      bun,
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(bun, 0o755);
    const invoked = spawnSync("/bin/sh", ["-c", result.stdout], {
      cwd: result.directory,
      env: { ...process.env, PATH: `${result.directory}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(
      invoked.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      ["attempt-1", "attempt-2"].map((attempt) => [
        join(result.directory, "source checkout/packages/clawhub/src/cli.ts"),
        "--no-input",
        "package",
        "recover",
        attempt,
        "--manual-override-reason",
        reason,
        "--wait",
        "--wait-timeout",
        "1800",
        "--json",
      ]),
    );
  });

  it.each([
    { ...pending, name: "@openclaw/other", version: "2026.9.8" },
    { ...pending, name: "@openclaw/other", attemptId: undefined },
    { ...pending, name: "@openclaw/other", publicationStatus: "blocked" },
    pending,
  ])("rejects incomplete or mixed evidence before emitting any recovery command", (invalid) => {
    const result = render([pending, invalid]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
