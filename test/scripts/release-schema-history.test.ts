import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cli = fileURLToPath(new URL("../../scripts/release-schema-history.mjs", import.meta.url));

function fixture() {
  const root = tempDirs.make("release-schema-history-");
  const directory = path.join(root, "docs/reference/database-schemas");
  fs.mkdirSync(directory, { recursive: true });
  const files = ["state", "agent"].map((kind) => path.join(directory, `${kind}-schema-history.md`));
  const content = [
    "# Schema history",
    "",
    "Unreleased changes need a verified backup.",
    "",
    "| Version | Change | Published in |",
    "| ------- | ------ | ------------ |",
    "| 1 | Initial store | `v2026.9.1` |",
    "| 2 | Earlier beta | `v2026.9.2-beta.1` |",
    "| 3 | Unreleased migration description | Unreleased |",
    "| 4-5 | Consolidation | Unreleased |",
    "",
  ].join("\n");
  for (const file of files) {
    fs.writeFileSync(file, content);
  }
  return { root, files, content };
}

it.each(["2026.10.1", "v2026.10.1-beta.1"])(
  "stamps both histories for %s without changing published facts or prose, and is idempotent",
  (version) => {
    const { root, files, content } = fixture();
    const tag = version.startsWith("v") ? version : `v${version}`;
    const expected = content
      .replace("description | Unreleased |", `description | \`${tag}\` |`)
      .replace("Consolidation | Unreleased |", `Consolidation | \`${tag}\` |`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, [cli, version], { cwd: root, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(files.map((file) => fs.readFileSync(file, "utf8"))).toEqual([expected, expected]);
    }
  },
);

it.each([{ args: [] }, { args: ["next"] }, { args: ["2026.10.1", "extra"] }])(
  "rejects invalid release arguments $args before changing either file",
  ({ args }) => {
    const { root, files, content } = fixture();
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected one stable or beta release version");
    expect(files.map((file) => fs.readFileSync(file, "utf8"))).toEqual([content, content]);
  },
);
