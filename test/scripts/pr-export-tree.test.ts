import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const exporter = resolve("scripts/pr-lib/export-tree.py");

it.skipIf(process.platform === "win32")(
  "exports archive-equivalent bytes and modes with bounded object reads",
  () => {
    const root = temps.make("pr-export-tree-");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env });
    git("init", "-q");
    git("config", "maintenance.auto", "false");
    git("config", "core.hooksPath", "/dev/null");
    mkdirSync(join(repo, "scripts/sub"), { recursive: true });
    writeFileSync(join(repo, "scripts/pr"), "#!/bin/sh\necho fixture\n");
    chmodSync(join(repo, "scripts/pr"), 0o755);
    writeFileSync(
      join(repo, 'scripts/sub/quote" tab\t line\n雪.bin'),
      Buffer.from([0, 255, 10, 13]),
    );
    writeFileSync(join(repo, "scripts/empty"), "");
    symlinkSync('sub/quote" tab\t line\n雪.bin', join(repo, "scripts/link"));
    for (let i = 0; i < 100; i++) {
      mkdirSync(join(repo, `unrelated/${i}`), { recursive: true });
      writeFileSync(join(repo, `unrelated/${i}/file`), `unrelated ${i}`);
    }
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    git("repack", "-ad", "--window=0");

    const inline = readFileSync("scripts/pr", "utf8")
      .split("<<'EOF_WRAPPER_GIT'\n")[1]!
      .split("\nEOF_WRAPPER_GIT")[0]!;
    const revisionTrace = join(root, "revisions.trace");
    const revisions = execFileSync(
      process.execPath,
      ["--input-type=module", "-", "git", "revisions", repo, "HEAD", "scripts/pr", "scripts/sub"],
      { input: inline, env: { ...env, GIT_TRACE_PACK_ACCESS: revisionTrace } },
    );
    expect(revisions).toEqual(git("rev-parse", "HEAD:scripts/pr", "HEAD:scripts/sub"));
    expect(readFileSync(revisionTrace, "utf8").trim().split("\n").length).toBeLessThanOrEqual(4);

    const inventory = (directory: string): unknown[] =>
      readdirSync(directory)
        .toSorted()
        .flatMap((name): unknown[] => {
          const path = join(directory, name);
          const stat = lstatSync(path);
          return stat.isDirectory()
            ? [[name, inventory(path)]]
            : [
                [
                  name,
                  stat.mode & 0o777,
                  stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path),
                ],
              ];
        });
    for (const paths of [["scripts"], []]) {
      const suffix = paths.length ? "selected" : "full";
      const expected = join(root, `${suffix}-archive`);
      const actual = join(root, `${suffix}-export`);
      mkdirSync(expected);
      mkdirSync(actual);
      const archive = join(root, `${suffix}.tar`);
      git("archive", `--output=${archive}`, "HEAD", "--", ...paths);
      execFileSync("tar", ["-xf", archive, "-C", expected]);
      const trace = join(root, `${suffix}.trace`);
      execFileSync("python3", ["-I", "-B", exporter, "git", repo, "HEAD", actual, ...paths], {
        env: { ...env, GIT_TRACE_PACK_ACCESS: trace },
      });
      expect(inventory(actual)).toEqual(inventory(expected));
      if (paths.length) {
        // Four selected files plus their commit and ancestor trees; the hundred
        // unrelated subtrees must never be expanded or have their blobs opened.
        expect(readFileSync(trace, "utf8").trim().split("\n").length).toBeLessThanOrEqual(9);
      }
    }
  },
);
