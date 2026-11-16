import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { AGENT_GIT_SHIM } from "./agent-git-shim.js";

async function withHistoryFixture(
  run: (fixture: Awaited<ReturnType<typeof historyFixture>>) => Promise<void>,
) {
  await withTempDir("agent-git-blobs-", async (root) => run(await historyFixture(root)));
}

async function writeFakeSleep(dir: string) {
  await fs.writeFile(
    path.join(dir, "sleep"),
    [
      "#!/bin/sh",
      "count=0",
      '[ -f "$OPENCLAW_FAKE_SLEEP_COUNT" ] && count=$(cat "$OPENCLAW_FAKE_SLEEP_COUNT")',
      "count=$((count + 1))",
      'echo "$count" > "$OPENCLAW_FAKE_SLEEP_COUNT"',
      'if [ -n "$OPENCLAW_FAKE_SLEEP_RELEASE" ] && [ "$count" -ge "$OPENCLAW_FAKE_SLEEP_RELEASE" ]; then',
      '  /bin/rm -f "$OPENCLAW_FAKE_LEGACY/pid"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

async function historyFixture(
  root: string,
  versions = 12,
  append = true,
  options: { rename?: boolean; unchangedRange?: boolean; merge?: boolean } = {},
) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "gc.auto",
    GIT_CONFIG_VALUE_0: "0",
    GIT_CONFIG_KEY_1: "maintenance.auto",
    GIT_CONFIG_VALUE_1: "false",
  };
  const git = (cwd: string, args: string[], input?: string) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { env, input, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const origin = path.join(root, "origin");
  const seed = path.join(root, "seed");
  let file = "folder/history file.txt";
  const shim = path.join(root, "git");
  await fs.writeFile(shim, AGENT_GIT_SHIM, { mode: 0o755 });
  git(root, ["init", "--initial-branch=main", origin]);
  git(origin, ["config", "uploadpack.allowFilter", "true"]);
  let input = "";
  let content = "";
  for (let index = 0; index < versions; index++) {
    content = `${append ? content : ""}history line ${index}\n`;
    const other = `unrelated version ${index}\n`;
    const fileChange =
      options.unchangedRange && index >= versions - 4 && index < versions - 1
        ? ""
        : `M 100644 inline ${file}\ndata ${content.length}\n${content}\n`;
    input += `commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> ${1700000000 + index} +0000\ndata 7\nhistory\n${fileChange}M 100644 inline other.txt\ndata ${other.length}\n${other}\n`;
  }
  git(origin, ["fast-import", "--quiet"], input);
  git(origin, ["reset", "--hard", "HEAD"]);
  git(origin, ["repack", "-adq"]);
  if (options.rename) {
    for (const next of ["first renamed.txt", "folder/second renamed.txt"]) {
      await fs.mkdir(path.dirname(path.join(origin, next)), { recursive: true });
      git(origin, ["mv", file, next]);
      await fs.appendFile(path.join(origin, next), `line added in ${next}\n`);
      git(origin, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-am",
        "rename and edit",
      ]);
      file = next;
    }
  }
  if (options.merge) {
    git(origin, ["branch", "side", "HEAD~1"]);
    for (const branch of ["main", "side"]) {
      git(origin, ["checkout", branch]);
      await fs.writeFile(path.join(origin, file), `${branch} content\n`);
      git(origin, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-am",
        branch,
      ]);
    }
    git(origin, ["checkout", "main"]);
    git(origin, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "merge",
      "--no-commit",
      "-s",
      "ours",
      "side",
    ]);
    await fs.writeFile(path.join(origin, file), "merged content\n");
    git(origin, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-am",
      "merge",
    ]);
  }
  git(root, ["clone", "--filter=blob:none", "--no-checkout", pathToFileURL(origin).href, seed]);
  const seedHead = git(origin, ["rev-parse", "HEAD"]).trim();
  await fs.writeFile(path.join(origin, file), "new tip\n");
  git(origin, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-am",
    "origin advanced",
  ]);
  // Keep the oracle at the reader's revision while origin advertises a newer main.
  const oracle = path.join(root, "oracle");
  git(origin, ["worktree", "add", "--detach", oracle, seedHead]);
  let sequence = 0;
  const reader = async () => {
    const base = path.join(root, `base-${sequence}`);
    const linked = path.join(root, `reader ${sequence++}`);
    await fs.cp(seed, base, { recursive: true });
    git(base, ["config", "gc.auto", "0"]);
    git(base, ["config", "maintenance.auto", "false"]);
    git(base, ["worktree", "add", "--detach", linked]);
    const packet = path.join(root, `packet-${sequence}`);
    const packs = async () =>
      (await fs.readdir(path.join(base, ".git/objects/pack"))).filter((name) =>
        name.endsWith(".pack"),
      );
    const before = await packs();
    const invoke = (args: string[], cwd = linked, extraEnv: NodeJS.ProcessEnv = {}) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(shim, ["-C", root, "-C", cwd, ...args], {
          cwd: root,
          env: { ...env, GIT_TRACE_PACKET: packet, ...extraEnv },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    const newPacks = async () => (await packs()).filter((name) => !before.includes(name));
    const requests = async () => {
      const trace = await fs.readFile(packet, "utf8").catch(() => "");
      return [...trace.matchAll(/fetch> want ([a-f0-9]+)/g)].map((match) => match[1]);
    };
    return { base, linked, invoke, newPacks, requests };
  };
  return { root, origin: oracle, file, git, reader };
}

it.skipIf(process.platform === "win32")(
  "batches historical blobs while preserving native command output and path scope",
  () =>
    withHistoryFixture(async ({ origin, file, git, reader }) => {
      for (const args of [
        ["log", "-p", "--", file],
        ["log", "--stat", "--max-count=3", "--", file],
        ["log", "--patch", "HEAD~5..HEAD~1", "--", file],
        ["log", "--oneline", "-Shistory line 3", "HEAD~8..HEAD", "--", file],
        ["log", "--format=%H", "-S", "history line 3", "-n", "1", "--", file],
        ["log", "-G", "history line [34]", "--pickaxe-all", "--", file],
        ["log", "-Shistory line [34]", "--pickaxe-regex", "--", file],
        ["blame", "HEAD", "--", file],
        ["blame", file],
        ["diff", "HEAD~8", "HEAD~2", "--", file],
        ["diff", "HEAD~8..HEAD~2", "--", file],
        ["grep", "-n", "-G", "history", "HEAD~8", "HEAD~2", "--", file],
        ["log", "--oneline", "-Shistory"],
        ["log", "-Ghistory", "HEAD~8..HEAD~2"],
        ["log", "-p", "HEAD~8..HEAD~2"],
        ["log", "--stat", "HEAD~8..HEAD~2"],
        ["log", "--numstat", "HEAD~8..HEAD~2"],
        ["diff", "HEAD~8..HEAD~2"],
        ["grep", "-G", "version", "HEAD~8"],
        ["grep", "-e", "version", "HEAD~8"],
      ]) {
        const { invoke, newPacks, requests } = await reader();
        const result = await invoke(args);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout, args.join(" ")).toBe(git(origin, args));
        expect.soft(await newPacks(), args.join(" ")).toHaveLength(1);
        const wanted = await requests();
        expect.soft(new Set(wanted).size, args.join(" ")).toBe(wanted.length);
        const unrelated = git(origin, [
          "log",
          "--format=",
          "--raw",
          "--no-abbrev",
          "--",
          "other.txt",
        ]);
        if (args.includes(file)) {
          for (const oid of wanted) {
            expect(unrelated, args.join(" ")).not.toContain(oid);
          }
        }
        if (args[0] === "diff") {
          expect(wanted).toHaveLength(args.includes(file) ? 2 : 4);
        }
      }
      const { linked, invoke, newPacks } = await reader();
      for (const revision of ["HEAD~10", "HEAD~5", "HEAD~1"]) {
        const args = ["show", `${revision}:./history file.txt`];
        const result = await invoke(args, path.join(linked, "folder"));
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(git(path.join(origin, "folder"), args));
      }
      expect(await newPacks()).toHaveLength(1);
    }),
);

it.skipIf(process.platform === "win32")(
  "shares overlapping blob prefetches across linked worktrees and keeps offline reads offline",
  () =>
    withHistoryFixture(async ({ root, origin, file, git, reader }) => {
      for (const overlap of [false, true]) {
        const { base, linked, invoke, newPacks, requests } = await reader();
        const peer = path.join(root, overlap ? "overlap peer" : "identical peer");
        git(base, ["worktree", "add", "--detach", peer]);
        const first = ["log", "-Shistory", ...(overlap ? ["HEAD~5..HEAD"] : []), "--", file];
        const second = ["log", "-Shistory", "--", file];
        const results = await Promise.all([invoke(first, linked), invoke(second, peer)]);
        for (const [index, result] of results.entries()) {
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toBe(git(origin, index === 0 ? first : second));
        }
        expect((await newPacks()).length).toBeLessThanOrEqual(overlap ? 2 : 1);
        const wanted = await requests();
        expect(new Set(wanted).size).toBe(wanted.length);
      }
      // A failed explicit batch must not fall through to per-object lazy fetches.
      const bin = path.join(root, "failed-batch");
      await fs.mkdir(bin);
      const fetchLog = path.join(root, "failed-fetch.log");
      await fs.writeFile(
        path.join(bin, "git"),
        `#!/bin/sh
for arg do
  if [ "$arg" = fetch ]; then
    echo fetch >> "$OPENCLAW_FIXTURE_FETCH_LOG"
    exit 1
  fi
done
exec "$OPENCLAW_FIXTURE_GIT" "$@"
`,
        { mode: 0o755 },
      );
      const failed = await reader();
      const failure = await failed.invoke(["log", "-p", "--", file], undefined, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        OPENCLAW_FIXTURE_GIT: path.join(git(root, ["--exec-path"]).trim(), "git"),
        OPENCLAW_FIXTURE_FETCH_LOG: fetchLog,
      });
      expect(await fs.readFile(fetchLog, "utf8")).toBe("fetch\n");
      expect(await failed.newPacks()).toHaveLength(0);
      expect(await failed.requests()).toHaveLength(0);
      expect(failure.code).toBe(2);
      expect(failure.stderr).toContain("pathspec");
      const { invoke, newPacks, requests } = await reader();
      const result = await invoke(["log", "-p", "--", file], undefined, { GIT_NO_LAZY_FETCH: "1" });
      expect(result.code).not.toBe(0);
      expect((await invoke(["--no-lazy-fetch", "log", "-p", "--", file])).code).not.toBe(0);
      expect(await newPacks()).toHaveLength(0);
      expect(await requests()).toHaveLength(0);
      expect((await invoke(["blame"])).code).not.toBe(0);
      const metadata = ["log", "--format=%H", "--", file];
      expect((await invoke(metadata)).stdout).toBe(git(origin, metadata));
      expect(await requests()).toHaveLength(0);
      const noMatch = await reader();
      expect((await noMatch.invoke(["grep", "absent-pattern", "HEAD~1"])).code).toBe(1);
      const unsupported = ["show", "--format=short", `HEAD~1:${file}`];
      const shown = await invoke(unsupported);
      expect(shown.code, shown.stderr).toBe(0);
      expect(shown.stdout).toBe(git(origin, unsupported));
      expect(await requests()).toHaveLength(1);
    }),
);

it.skipIf(process.platform === "win32")(
  "bounds content discovery without falling back to lazy-fetch packs",
  () =>
    withTempDir("agent-git-blob-bound-", async (root) => {
      const { origin, file, git, reader } = await historyFixture(root, 2050, false);
      const { invoke, requests } = await reader();
      const showArgs = ["show", `HEAD~1:${file}`];
      const showResult = await invoke(showArgs);
      expect(showResult.code, showResult.stderr).toBe(0);
      expect(showResult.stdout).toBe(git(origin, showArgs));
      expect(await requests()).toHaveLength(1);
      for (const args of [
        ["log", "--oneline", "-S", "selectThemeSettings"],
        ["-c", "log.follow=true", "log", "--oneline", "-S", "selectThemeSettings"],
        ["log", "-G", "history"],
        ["log", "-p"],
        ["blame", "HEAD", "--", file],
      ]) {
        const search = await reader();
        const searched = await search.invoke(args);
        expect.soft(await search.newPacks(), args.join(" ")).toHaveLength(0);
        expect.soft(await search.requests(), args.join(" ")).toHaveLength(0);
        expect.soft(searched.code, args.join(" ")).toBe(2);
        expect.soft(searched.stderr).toContain("pathspec");
        expect.soft(searched.stderr).toContain("git grep");
        expect.soft(searched.stderr).toContain("--since");
      }
      const narrowed = await reader();
      for (const args of [
        ["log", "-S", "history", "--since=2023-11-14T22:45:00Z", "--", file],
        ["grep", "history", "HEAD~1", "--", file],
      ]) {
        const result = await narrowed.invoke(args);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(git(origin, args));
      }
      // A closure beyond the discovery budget is still usable when already local.
      const hydrated = await reader();
      const objects = git(hydrated.base, [
        "rev-list",
        "--objects",
        "--missing=print",
        "HEAD",
        "--",
        file,
      ])
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .map((line) => line.slice(1))
        .join("\n");
      git(
        hydrated.base,
        [
          "-c",
          "fetch.negotiationAlgorithm=noop",
          "fetch",
          "--filter=blob:none",
          "--no-auto-maintenance",
          "origin",
          "--stdin",
        ],
        objects + "\n",
      );
      const before = await hydrated.newPacks();
      const hydratedArgs = ["log", "--oneline", "-S", "history", "--", file];
      expect((await hydrated.invoke(hydratedArgs)).stdout).toBe(git(origin, hydratedArgs));
      expect(await hydrated.newPacks()).toEqual(before);
    }),
);

it.skipIf(process.platform === "win32")(
  "batches blame history across edited renames without unrelated blobs",
  () =>
    withTempDir("agent-git-renames-", async (root) => {
      const { origin, file, git, reader } = await historyFixture(root, 12, true, { rename: true });
      for (const mode of ["default", "flag", "environment", "relative", "follow"]) {
        const { linked, invoke, newPacks, requests } = await reader();
        const relative = mode === "relative";
        const prefix = mode === "flag" ? ["--literal-pathspecs"] : [];
        if (relative) {
          prefix.push("-c", "diff.relative=true");
        }
        if (mode === "follow") {
          prefix.push("-c", "log.follow=true");
        }
        const args = [...prefix, "blame", "HEAD", "--", relative ? path.basename(file) : file];
        const result = await invoke(
          args,
          relative ? path.join(linked, "folder") : linked,
          mode === "environment" ? { GIT_LITERAL_PATHSPECS: "1" } : {},
        );
        expect.soft(result.code, `${mode}: ${result.stderr}`).toBe(0);
        expect
          .soft(result.stdout, mode)
          .toBe(git(relative ? path.join(origin, "folder") : origin, args));
        expect.soft(await newPacks(), mode).toHaveLength(1);
        expect.soft(await requests(), mode).toHaveLength(13);
      }
      for (const args of [
        ["-c", "log.follow=true", "log", "-p", file],
        ["-c", "log.follow=true", "log", "-p", "--", file],
        ["log", "-p", "other.txt"],
      ]) {
        const { invoke } = await reader();
        const result = await invoke(args);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(git(origin, args));
      }
    }),
);

it.skipIf(process.platform === "win32")(
  "prepares the endpoint content for a blame range with no file changes",
  () =>
    withTempDir("agent-git-blame-range-", async (root) => {
      const { origin, file, git, reader } = await historyFixture(root, 12, true, {
        unchangedRange: true,
      });
      for (const args of [
        ["blame", "HEAD~3..HEAD~1", "--", file],
        ["-c", "log.showRoot=false", "blame", "HEAD~11", "--", file],
      ]) {
        const { invoke, newPacks } = await reader();
        const result = await invoke(args);
        expect.soft(result.code, result.stderr).toBe(0);
        expect.soft(result.stdout).toBe(git(origin, args));
        expect.soft(await newPacks()).toHaveLength(1);
      }
    }),
);

it.skipIf(process.platform === "win32")("prepares every parent of a combined merge diff", () =>
  withTempDir("agent-git-combined-diff-", async (root) => {
    const { origin, file, git, reader } = await historyFixture(root, 12, true, { merge: true });
    for (const revisions of [["HEAD^!"], ["HEAD", "HEAD^1", "HEAD^2"]]) {
      const { invoke, newPacks } = await reader();
      const args = ["diff", ...revisions, "--", file];
      const result = await invoke(args);
      const expected = git(origin, args);
      expect(expected).toContain("diff --cc");
      expect.soft(result.code, result.stderr).toBe(0);
      expect.soft(result.stdout).toBe(expected);
      expect.soft(await newPacks()).toHaveLength(1);
    }
  }),
);

it.skipIf(process.platform === "win32")(
  "admits one history prefetch at a time across racing linked worktrees",
  () =>
    withHistoryFixture(async ({ root, origin, file, git, reader }) => {
      const { base, linked, invoke } = await reader();
      // The lock lives in the shared common directory, so the racers must be
      // linked worktrees of one repository rather than separate clones.
      const peers = [linked];
      while (peers.length < 6) {
        const peer = path.join(root, `race peer ${peers.length}`);
        git(base, ["worktree", "add", "--detach", peer]);
        peers.push(peer);
      }
      // A git wrapper on PATH journals every fetch boundary and holds the fetch
      // open long enough that an overlap cannot hide inside a few milliseconds.
      const wrapper = path.join(root, "wrapper");
      const journal = path.join(root, "lock.journal");
      await fs.mkdir(wrapper);
      await fs.writeFile(
        path.join(wrapper, "git"),
        [
          "#!/bin/sh",
          'case " $* " in',
          '  *" fetch "*)',
          '    echo enter >> "$OPENCLAW_LOCK_JOURNAL"',
          "    sleep 0.6",
          '    "$OPENCLAW_LOCK_GIT" "$@"',
          "    status=$?",
          '    echo leave >> "$OPENCLAW_LOCK_JOURNAL"',
          '    exit "$status" ;;',
          "esac",
          'exec "$OPENCLAW_LOCK_GIT" "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const env = {
        PATH: `${wrapper}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_LOCK_GIT: realGit,
        OPENCLAW_LOCK_JOURNAL: journal,
      };
      const history = ["log", "--stat", "--", file];
      const unrelated = ["log", "--stat", "--", "other.txt"];
      const results = await Promise.all(
        peers.map((peer, index) => invoke(index % 2 === 0 ? history : unrelated, peer, env)),
      );
      for (const [index, result] of results.entries()) {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(git(origin, index % 2 === 0 ? history : unrelated));
      }
      const events = (await fs.readFile(journal, "utf8")).trim().split("\n");
      // The two object sets are disjoint, so each group fetches once. Two enters
      // with no leave between them are the overlap the kernel lock must forbid.
      expect(events.filter((event) => event === "enter")).toHaveLength(2);
      expect(events.filter((event) => event === "leave")).toHaveLength(2);
      let inside = false;
      for (const event of events) {
        expect(event, events.join(",")).toBe(inside ? "leave" : "enter");
        inside = !inside;
      }
      expect(inside).toBe(false);
      expect(
        (await fs.stat(path.join(base, ".git", "openclaw-history-blobs.lock.kernel"))).isFile(),
      ).toBe(true);
    }),
);

it.skipIf(process.platform === "win32")(
  "gives up the prefetch on a legacy lock marker whose pid was reused",
  () =>
    withHistoryFixture(async ({ root, file, reader }) => {
      const { base, linked, invoke, newPacks, requests } = await reader();
      // An older shim's directory record whose pid now belongs to a long-lived
      // process of the same user: kill -0 succeeds, so the bounded wait has to
      // expire rather than wait for good.
      const legacy = path.join(base, ".git", "openclaw-history-blobs.lock");
      await fs.mkdir(legacy);
      await fs.writeFile(path.join(legacy, "pid"), `${process.pid}\n`);
      const wrapper = path.join(root, "legacy sleep");
      await fs.mkdir(wrapper);
      await writeFakeSleep(wrapper);
      const counter = path.join(root, "legacy sleep count");
      const started = Date.now();
      // Pickaxe is the content search the review named: after the bounded wait
      // it must take the failed-preparation path, not native lazy Git.
      const result = await invoke(["log", "-S", "history line 3", "--", file], linked, {
        PATH: `${wrapper}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_FAKE_SLEEP_COUNT: counter,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      // The loop sleeps 299 times and gives up on the 300th attempt.
      expect(Number(await fs.readFile(counter, "utf8"))).toBe(299);
      // The prefetch is given up and the content search stays offline: no
      // per-blob lazy fetch starts beside the live legacy owner.
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain("pathspec");
      expect(result.stderr).toContain("shared partial-clone blob budget");
      expect(await newPacks()).toHaveLength(0);
      expect(await requests()).toHaveLength(0);
      // The wait runs before the kernel lock, so a timed-out caller never
      // creates the kernel lock file; the legacy marker is never removed.
      expect(
        await fs
          .stat(path.join(base, ".git", "openclaw-history-blobs.lock.kernel"))
          .catch(() => null),
      ).toBeNull();
      expect((await fs.stat(legacy)).isDirectory()).toBe(true);
    }),
  30_000,
);

it.skipIf(process.platform === "win32")(
  "releases the legacy wait when the marker disappears before the bound",
  () =>
    withHistoryFixture(async ({ root, origin, file, git, reader }) => {
      const { base, linked, invoke, newPacks } = await reader();
      const legacy = path.join(base, ".git", "openclaw-history-blobs.lock");
      await fs.mkdir(legacy);
      await fs.writeFile(path.join(legacy, "pid"), `${process.pid}\n`);
      const wrapper = path.join(root, "release sleep");
      await fs.mkdir(wrapper);
      await writeFakeSleep(wrapper);
      const counter = path.join(root, "release sleep count");
      const args = ["log", "--stat", "--", file];
      const result = await invoke(args, linked, {
        PATH: `${wrapper}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_FAKE_SLEEP_COUNT: counter,
        OPENCLAW_FAKE_SLEEP_RELEASE: "3",
        OPENCLAW_FAKE_LEGACY: legacy,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(git(origin, args));
      expect(await newPacks()).toHaveLength(1);
      expect(Number(await fs.readFile(counter, "utf8"))).toBe(3);
      expect(await fs.stat(path.join(legacy, "pid")).catch(() => null)).toBeNull();
    }),
  30_000,
);

it.skipIf(process.platform === "win32")(
  "serialises prefetches after a stale legacy marker",
  () =>
    withHistoryFixture(async ({ root, origin, file, git, reader }) => {
      const { base, linked, invoke } = await reader();
      const peer = path.join(root, "stale race peer");
      git(base, ["worktree", "add", "--detach", peer]);
      // A dead owner leaves the old directory record behind. The old shim
      // reclaims it and can remove a successor's lock; the kernel lock must
      // serialise the same two callers instead.
      const legacy = path.join(base, ".git", "openclaw-history-blobs.lock");
      await fs.mkdir(legacy);
      const deadPid = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
      await fs.writeFile(path.join(legacy, "pid"), `${deadPid}\n`);
      const wrapper = path.join(root, "stale wrapper");
      const journal = path.join(root, "stale journal");
      await fs.mkdir(wrapper);
      await fs.writeFile(
        path.join(wrapper, "git"),
        [
          "#!/bin/sh",
          'case " $* " in',
          '  *" fetch "*)',
          '    echo enter >> "$OPENCLAW_STALE_JOURNAL"',
          '    sleep "$OPENCLAW_STALE_HOLD"',
          '    "$OPENCLAW_STALE_GIT" "$@"',
          "    status=$?",
          '    echo leave >> "$OPENCLAW_STALE_JOURNAL"',
          '    exit "$status" ;;',
          "esac",
          'exec "$OPENCLAW_STALE_GIT" "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(wrapper, "rm"),
        [
          "#!/bin/sh",
          'case "$1 $2" in',
          '  "-f "*"openclaw-history-blobs.lock/pid")',
          '    sleep "$OPENCLAW_STALE_RM_DELAY" ;;',
          "esac",
          'exec /bin/rm "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const env = {
        PATH: `${wrapper}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_STALE_GIT: realGit,
        OPENCLAW_STALE_JOURNAL: journal,
        OPENCLAW_STALE_HOLD: "6",
      };
      const history = ["log", "--stat", "--", file];
      const unrelated = ["log", "--stat", "--", "other.txt"];
      const results = await Promise.all([
        invoke(history, linked, { ...env, OPENCLAW_STALE_RM_DELAY: "2" }),
        invoke(unrelated, peer, { ...env, OPENCLAW_STALE_RM_DELAY: "5" }),
      ]);
      for (const [index, result] of results.entries()) {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(git(origin, index === 0 ? history : unrelated));
      }
      const events = (await fs.readFile(journal, "utf8")).trim().split("\n");
      // Two disjoint object sets, so two fetches. The delayed rm opens the
      // old reclaim window; the journal must not contain two enters in a row.
      expect(events.filter((event) => event === "enter")).toHaveLength(2);
      expect(events.filter((event) => event === "leave")).toHaveLength(2);
      let inside = false;
      for (const event of events) {
        expect(event, events.join(",")).toBe(inside ? "leave" : "enter");
        inside = !inside;
      }
      expect(inside).toBe(false);
    }),
  60_000,
);

it.skipIf(process.platform !== "linux")(
  "falls back to the directory mutex when flock is unavailable",
  () =>
    withHistoryFixture(async ({ root, origin, file, git, reader }) => {
      const { base, linked, invoke, newPacks } = await reader();
      const wrapper = path.join(root, "no flock");
      await fs.mkdir(wrapper);
      await fs.writeFile(path.join(wrapper, "flock"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const args = ["log", "--stat", "--", file];
      const result = await invoke(args, linked, {
        PATH: `${wrapper}${path.delimiter}${process.env.PATH ?? ""}`,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(git(origin, args));
      expect(await newPacks()).toHaveLength(1);
      expect(
        await fs
          .stat(path.join(base, ".git", "openclaw-history-blobs.lock.fallback"))
          .catch(() => null),
      ).toBeNull();
    }),
);

it.skipIf(process.platform !== "linux")(
  "falls back to the directory mutex when flock is missing from PATH",
  () =>
    withHistoryFixture(async ({ root, origin, file, git, reader }) => {
      const { linked, invoke, newPacks } = await reader();
      const minimal = path.join(root, "minimal path");
      await fs.mkdir(minimal);
      for (const command of [
        "git",
        "awk",
        "cat",
        "grep",
        "mkdir",
        "rm",
        "rmdir",
        "sed",
        "sh",
        "sleep",
        "uname",
        "wc",
      ]) {
        const resolved = spawnSync("sh", ["-c", `command -v ${command}`], {
          encoding: "utf8",
        }).stdout.trim();
        expect(resolved, command).not.toBe("");
        await fs.symlink(resolved, path.join(minimal, command));
      }
      const args = ["log", "--stat", "--", file];
      const result = await invoke(args, linked, { PATH: minimal });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(git(origin, args));
      expect(await newPacks()).toHaveLength(1);
    }),
);

it.skipIf(process.platform !== "linux")(
  "serialises fallback prefetches and removes the fallback marker",
  () =>
    withHistoryFixture(async ({ root, origin, file, git, reader }) => {
      const { base, linked, invoke } = await reader();
      const peer = path.join(root, "fallback peer");
      git(base, ["worktree", "add", "--detach", peer]);
      const wrapper = path.join(root, "fallback wrapper");
      const journal = path.join(root, "fallback journal");
      await fs.mkdir(wrapper);
      await fs.writeFile(path.join(wrapper, "flock"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      await fs.writeFile(
        path.join(wrapper, "git"),
        [
          "#!/bin/sh",
          'case " $* " in',
          '  *" fetch "*)',
          '    echo enter >> "$OPENCLAW_FALLBACK_JOURNAL"',
          "    sleep 0.6",
          '    "$OPENCLAW_FALLBACK_GIT" "$@"',
          "    status=$?",
          '    echo leave >> "$OPENCLAW_FALLBACK_JOURNAL"',
          '    exit "$status" ;;',
          "esac",
          'exec "$OPENCLAW_FALLBACK_GIT" "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const env = {
        PATH: `${wrapper}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_FALLBACK_GIT: realGit,
        OPENCLAW_FALLBACK_JOURNAL: journal,
      };
      const history = ["log", "--stat", "--", file];
      const unrelated = ["log", "--stat", "--", "other.txt"];
      const results = await Promise.all([
        invoke(history, linked, env),
        invoke(unrelated, peer, env),
      ]);
      for (const [index, result] of results.entries()) {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(git(origin, index === 0 ? history : unrelated));
      }
      expect((await fs.readFile(journal, "utf8")).trim().split("\n")).toEqual([
        "enter",
        "leave",
        "enter",
        "leave",
      ]);
      expect(
        await fs
          .stat(path.join(base, ".git", "openclaw-history-blobs.lock.fallback"))
          .catch(() => null),
      ).toBeNull();
    }),
  60_000,
);

it.skipIf(process.platform !== "linux")(
  "waits on an orphaned fallback marker and leaves it for manual rescue",
  () =>
    withHistoryFixture(async ({ root, file, reader }) => {
      const { base, linked, invoke, newPacks, requests } = await reader();
      const fallback = path.join(base, ".git", "openclaw-history-blobs.lock.fallback");
      await fs.mkdir(fallback);
      await fs.writeFile(path.join(fallback, "pid"), "999999\n");
      const wrapper = path.join(root, "orphan wrapper");
      await fs.mkdir(wrapper);
      await fs.writeFile(path.join(wrapper, "flock"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      await writeFakeSleep(wrapper);
      const counter = path.join(root, "orphan sleep count");
      const started = Date.now();
      const result = await invoke(["log", "-S", "history line 3", "--", file], linked, {
        PATH: `${wrapper}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_FAKE_SLEEP_COUNT: counter,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(Number(await fs.readFile(counter, "utf8"))).toBe(299);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain("shared partial-clone blob budget");
      expect(await newPacks()).toHaveLength(0);
      expect(await requests()).toHaveLength(0);
      expect((await fs.stat(fallback)).isDirectory()).toBe(true);
    }),
  30_000,
);
