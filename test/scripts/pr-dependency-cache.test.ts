import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

function bootstrapSource() {
  return readFileSync("scripts/pr", "utf8")
    .split("<<'EOF_TOOLING'\n")[1]!
    .split("\nEOF_TOOLING")[0]!;
}

// Exercise the embedded bootstrap without installing packages or adding a test-only entrypoint.
function sweep(cache: string, current = "") {
  const source = bootstrapSource();
  if (!source?.includes("materializeDependencies(...process.argv.slice(2));")) {
    throw new Error("Missing dependency bootstrap entrypoint");
  }
  const result = spawnSync(requireNodeTool("node"), ["--input-type=module", "-", cache, current], {
    input: source.replace(
      "materializeDependencies(...process.argv.slice(2));",
      "sweep(...process.argv.slice(2));",
    ),
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
}

function entry(cache: string, name: string, ageHours: number, complete = true) {
  const path = join(cache, name);
  mkdirSync(path, { mode: 0o700 });
  if (complete) {
    mkdirSync(join(path, ".pr-complete"));
  }
  const modified = new Date(Date.now() - ageHours * 3_600_000);
  utimesSync(path, modified, modified);
  return path;
}

describePosix("frozen PR dependency identity", () => {
  it("reuses installs across source heads, invalidates inputs, and isolates unaudited hooks", () => {
    const root = tempDirs.make("pr-dependency-inputs-");
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trimEnd();
    };
    const write = (name: string, value: string) => {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), value);
    };
    git("init", "--quiet");
    const fixture = {
      "package.json": '{"scripts":{"prepare":"node scripts/prepare.mjs"}}',
      "ui/package.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "pnpm-workspace.yaml": "packages: [ui]",
      ".npmrc": "node-linker=isolated",
      "patches/example.patch": "patch",
      "scripts/prepare.mjs": "readFileSync('schema.sql')",
      "schema.sql": "CREATE TABLE example (id INTEGER);",
      "packages/example/tsconfig.json": "{}",
      "packages/example/src/native.ts": "export const native = 1;",
      "src/page.ts": "export const page = 1;",
    };
    for (const [name, value] of Object.entries(fixture)) {
      write(name, value);
    }
    git("add", ".");
    const rows = () =>
      git("ls-files", "--stage", "-z")
        .split("\0")
        .filter(Boolean)
        .map((row) => row.replace(/ 0\t/, "\t").replace(" ", " blob "));
    const auditedRows = rows().filter((row) => !row.endsWith("\tsrc/page.ts"));
    // The bootstrap runs in Node even when Vitest runs in Bun.
    const node = requireNodeTool("node");
    const childRuntime = spawnSync(
      node,
      ["-p", "[process.platform, process.arch, process.versions.modules].join(' ')"],
      { encoding: "utf8" },
    );
    expect(childRuntime.status, childRuntime.stderr).toBe(0);
    const [platform, arch, modules] = childRuntime.stdout.trim().split(" ");
    const audit = {
      files: ["scripts/prepare.mjs", "schema.sql"],
      directories: ["packages/example/src"],
      presence: ["src"],
      runtime: { platform, arch, modules },
      auditSha256: createHash("sha256").update(auditedRows.join("\0")).digest("hex"),
    };
    const key = (policy: typeof audit | null = audit) => {
      git("add", ".");
      const payload = join(tempDirs.make("pr-key-payload-"), "input.json");
      writeFileSync(payload, JSON.stringify([rows(), git("write-tree"), policy]));
      const result = spawnSync(node, ["--input-type=module", "-", payload], {
        input: bootstrapSource().replace(
          "materializeDependencies(...process.argv.slice(2));",
          "process.stdout.write(dependencyKey(...JSON.parse(readFileSync(process.argv[2], 'utf8'))));",
        ),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const first = key();
    write("src/page.ts", "export const page = 2;");
    expect(key()).toBe(first);
    for (const [name, value] of Object.entries(fixture)) {
      if (name === "src/page.ts") {
        continue;
      }
      write(name, `${value}\n`);
      expect(key(), name).not.toBe(first);
      write(name, value);
    }
    write("schema.sql", "CREATE TABLE example (id TEXT);");
    const changedData = key();
    write("src/page.ts", "export const page = 3;");
    expect(key()).not.toBe(changedData);
    rmSync(join(root, "schema.sql"));
    symlinkSync("src/page.ts", join(root, "schema.sql"));
    const indirectData = key();
    write("src/page.ts", "export const page = 4;");
    expect(key()).not.toBe(indirectData);
    rmSync(join(root, "schema.sql"));
    write("schema.sql", fixture["schema.sql"]);
    write("src/page.ts", "export const page = 3;");
    write("scripts/prepare.mjs", "readFileSync('src/page.ts')");
    const unaudited = key();
    write("src/page.ts", "export const page = 4;");
    expect(key()).not.toBe(unaudited);
    const historical = key(null);
    write("src/page.ts", "export const page = 5;");
    expect(key(null)).not.toBe(historical);
  });
});

describePosix("frozen PR dependency cache sweep", () => {
  it("bounds each sweep while keeping newest unused installations and live consumers", () => {
    const cache = tempDirs.make("pr-dependency-cache-");
    // Deliberately reverse name/recency order; unused entries are younger than the old TTL.
    const names = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(64, "0"));
    for (const [index, name] of names.entries()) {
      entry(cache, name, (12 - index) / 4);
    }
    const current = join(cache, names[0]!);
    const live = join(cache, names[1]!);
    mkdirSync(join(live, ".pr-users", String(process.pid)), { recursive: true });
    mkdirSync(join(cache, names[2]!, ".pr-users", "2147483647"), { recursive: true });
    // Consumer bookkeeping must not accidentally change the fixture's recency.
    for (const name of names.slice(0, 3)) {
      utimesSync(join(cache, name), new Date(0), new Date(0));
    }

    sweep(cache, current);

    expect(readdirSync(cache).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...names.slice(0, 4), ...names.slice(-4)].toSorted((a, b) => a.localeCompare(b)),
    );

    sweep(cache, current);

    expect(readdirSync(cache).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...names.slice(0, 2), ...names.slice(-4)].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("shares the removal budget across installs and stages while preserving protected entries", () => {
    const cache = tempDirs.make("pr-dependency-stages-");
    entry(cache, "install-2147483647-dead", 25, false);
    entry(cache, "install-2147483647-recent", 1, false);
    entry(cache, `install-${process.pid}-live`, 25, false);
    const completed = Array.from({ length: 6 }, (_, index) =>
      (index + 10).toString(16).padStart(64, "0"),
    );
    for (const [index, name] of completed.entries()) {
      entry(cache, name, 26 + index);
    }
    entry(cache, "install-2147483647-older", 32, false);
    entry(cache, "install-2147483647-oldest", 33, false);
    const unsafe = entry(cache, "a".repeat(64), 25);
    chmodSync(unsafe, 0o755);
    entry(cache, "not-a-cache-entry", 25);
    const target = tempDirs.make("pr-dependency-symlink-");
    symlinkSync(target, join(cache, "b".repeat(64)));

    sweep(cache);

    const protectedEntries = [
      "a".repeat(64),
      "b".repeat(64),
      `install-${process.pid}-live`,
      "install-2147483647-recent",
      "not-a-cache-entry",
      ...completed.slice(0, 4),
    ];
    expect(readdirSync(cache).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...protectedEntries, "install-2147483647-oldest"].toSorted((a, b) => a.localeCompare(b)),
    );

    sweep(cache);

    expect(readdirSync(cache).toSorted((a, b) => a.localeCompare(b))).toEqual(
      protectedEntries.toSorted((a, b) => a.localeCompare(b)),
    );
    expect(readdirSync(target)).toEqual([]);
  });
});
