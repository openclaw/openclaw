import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const scriptPath = path.resolve("scripts/dated-todo-scan.mts");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeFixture(root: string, file: string, contents: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

describe("dated-todo-scan", () => {
  it("finds nearby dated commitments, ignores noise, and includes deprecated compat records", () => {
    const root = tempDirs.make("dated-todo-scan-");
    const reportRoot = tempDirs.make("dated-todo-report-");
    const scanned = {
      "src/direct.ts": "// TODO: remove this after 2026-10-01\n",
      "src/expiry.ts": "// Compatibility expiry: March 1 2027.\n",
      "src/expiration.ts": "// Temporary expiration: March 1, 2027.\n",
      "src/no-comma-space.ts": "// TODO remove after March 1,2027.\n",
      "src/timestamp.ts": "// Temporary expiry 2026-10-01T00:00:00Z.\n",
      "config/outside.ts": "// TODO remove after 2027-06-01.\n",
      "config/ignored.ts": "// TODO remove after 2027-06-02.\n",
      "docs/adjacent.md": "<!-- temporary workaround -->\nDeadline: March 2027.\n",
    };
    const excluded = {
      "src/history.ts": "// Released on 2026-01-01.\n",
      "src/no-date.ts": "// TODO: improve this eventually.\n",
      "src/too-far.ts": "// FIXME: remove this\nconst gap = true;\n// 2027-04-01\n",
      "CHANGELOG.md": "TODO remove after 2026-09-01\n",
      "test/fixtures/noise.ts": "// TODO remove after 2026-09-01\n",
      "docs/.generated/noise.md": "Temporary until 2026-09-01\n",
      "locales/en.json": '{"todo":"remove after 2026-09-01"}\n',
    };
    const fixtures = {
      ...scanned,
      ...excluded,
      ".gitignore": "config/ignored.ts\n",
      "test/removal.test.ts":
        "const removalDatePendingCompatCodes = [\n  // keep until July 2028\n];\n",
      "src/plugins/compat/registry.ts": [
        'const prefix = { code: "fixture-deprecation-extra" };',
        'const record = { code: "fixture-deprecation" };',
        "",
      ].join("\n"),
    };
    for (const [file, contents] of Object.entries(fixtures)) {
      writeFixture(root, file, contents);
    }
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["add", "-f", "config/ignored.ts"], { cwd: root });
    writeFixture(root, "src/untracked.ts", "// TODO remove after 2026-12-01\n");

    const compatReport = path.join(reportRoot, "compat.json");
    const records = [
      {
        code: "fixture-deprecation",
        status: "deprecated",
        removeAfter: "2026-11-15",
        replacement: "fixture replacement",
      },
      { code: "active-record", status: "active", removeAfter: "2026-12-01" },
      { code: "undated-deprecation", status: "deprecated" },
    ];
    writeFileSync(compatReport, JSON.stringify({ compat: { records } }));
    const output = path.join(root, ".artifacts", "candidates.json");
    const args = ["--root", root, "--output", output, "--compat-report", compatReport];
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const candidates = JSON.parse(readFileSync(output, "utf8")) as Array<{
      file: string;
      line: number;
      text: string;
      source: string;
    }>;
    expect(candidates).toEqual(
      expect.arrayContaining([
        ...Object.keys(scanned).map((file) =>
          expect.objectContaining({ file, line: 1, source: "scan" }),
        ),
        expect.objectContaining({ file: "test/removal.test.ts", line: 2, source: "scan" }),
        expect.objectContaining({
          file: "src/plugins/compat/registry.ts",
          line: 2,
          source: "compat-registry",
          text: expect.stringContaining("fixture-deprecation: removeAfter 2026-11-15"),
        }),
      ]),
    );
    const candidateFiles = candidates.map((candidate) => candidate.file);
    for (const excludedFile of [...Object.keys(excluded), "src/untracked.ts"]) {
      expect(candidateFiles).not.toContain(excludedFile);
    }
    expect(candidates.filter((candidate) => candidate.source === "compat-registry")).toHaveLength(
      1,
    );
  });
});
