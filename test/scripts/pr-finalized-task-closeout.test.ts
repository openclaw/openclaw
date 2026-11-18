import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { delimiter, join } from "node:path";
import { describe, expect } from "vitest";
import { WebSocketServer } from "ws";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";
import {
  copyPrRoutingWrapperSources,
  createIndependentPrFixtureEnv,
  linkPrWrapperDependencies,
} from "./pr-wrapper.test-support.js";

const owner = "11111111-1111-4111-8111-111111111111";
const peer = "22222222-2222-4222-8222-222222222222";
const it = createCommandTest().extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({ command }, use) => {
    await command.lifetime.run(async () => use(await fixture(command)));
  },
});
const describePosix = process.platform === "win32" ? describe.skip : describe;

async function fixture(command: CommandFixture) {
  const root = realpathSync(command.createTempDir("pr-fc-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [repo, home, bin]) {
    mkdirSync(dir);
  }
  copyPrRoutingWrapperSources(repo);
  writeFileSync(join(bin, "rg"), "#!/bin/sh\necho 'Unexpected rg call' >&2\nexit 99\n", {
    mode: 0o755,
  });
  const stateFile = join(root, "external-state.json");
  const calls = join(root, "native-calls.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...createIndependentPrFixtureEnv(),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    CODEX_THREAD_ID: owner,
    XDG_CONFIG_HOME: home,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_PARAMETERS:
      "'core.hooksPath=/dev/null' 'commit.gpgSign=false' 'gc.auto=0' 'maintenance.auto=false'",
    GIT_TERMINAL_PROMPT: "0",
    GH_REPO: "https://github.com/fixture/repo",
    OPENCLAW_GH_BIN: join(bin, "gh"),
    CLOSEOUT_FIXTURE_STATE: stateFile,
    CLOSEOUT_FIXTURE_CALLS: calls,
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    expect(result.status, `git ${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Closeout Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(
    join(repo, ".gitignore"),
    ".worktrees/\n.artifacts/\n.crabbox/\n.local/\nnode_modules\n.env\n",
  );
  git("add", ".");
  git("commit", "-qm", "test: trusted wrapper");
  const base = git("rev-parse", "HEAD");
  const worktree = join(repo, ".worktrees", "issue-191975");
  git("worktree", "add", "-q", "-b", "fix/task", worktree, base);
  writeFileSync(join(worktree, "tracked-result.txt"), "completed source change\n");
  git("-C", worktree, "add", "tracked-result.txt");
  git("-C", worktree, "commit", "-qm", "test: reviewed task head");
  const head = git("-C", worktree, "rev-parse", "HEAD");
  // Model the motivating external squash merge, with no native merge receipt.
  git("merge", "--squash", "fix/task");
  git("commit", "-qm", "test: external squash merge");
  const landed = git("rev-parse", "HEAD");
  git("remote", "add", "origin", "https://github.com/fixture/repo.git");
  git("update-ref", "refs/remotes/origin/main", landed);
  linkPrWrapperDependencies(repo);
  const template = join(repo, ".worktrees", ".templates", "unrelated");
  git("worktree", "add", "-q", "--detach", template, base);
  const shared = join(root, "shared-dependencies");
  mkdirSync(shared);
  writeFileSync(join(shared, "keep"), "shared dependencies\n");
  symlinkSync(shared, join(worktree, "node_modules"));
  const artifacts = [
    join(worktree, ".artifacts"),
    join(worktree, ".crabbox"),
    join(repo, ".artifacts", "task-proof"),
  ];
  for (const path of artifacts) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "proof.txt"), "task-owned proof\n");
  }
  symlinkSync(shared, join(artifacts[2]!, "dependency-link"));
  const unrelated = join(repo, ".artifacts", "unrelated");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep"), "unrelated proof\n");
  const threads: Record<
    string,
    { id: string; cwd: string; status: { type: string }; turns: unknown[]; environments: unknown[] }
  > = {
    [owner]: { id: owner, cwd: repo, status: { type: "active" }, turns: [], environments: [] },
    [peer]: { id: peer, cwd: unrelated, status: { type: "idle" }, turns: [], environments: [] },
  };
  const attachments: Record<string, { attachmentType: string; payload: unknown }[]> = {};
  const state = {
    head,
    landed,
    prState: "MERGED",
    unavailable: false,
    threads,
    attachments,
  };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  save();
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(process.env.CLOSEOUT_FIXTURE_STATE, "utf8"));
const repository = { id: 42, node_id: "fixture-repository", full_name: "fixture/repo", html_url: "https://github.com/fixture/repo" };
if (args[0] === "browse") { console.log(repository.html_url); process.exit(0); }
if (args.join(" ") === "api user --include") { console.log('HTTP/2.0 200 OK\\n\\n{"login":"fixture"}'); process.exit(0); }
const endpoint = args.find(arg => arg.startsWith("repos/"));
if (endpoint === "repos/fixture/repo") { console.log(JSON.stringify(repository)); process.exit(0); }
if (endpoint === "repos/fixture/repo/pulls/42") {
  console.log(JSON.stringify({ number:42, node_id:"fixture-pr", title:"Completed task", state:s.prState === "MERGED" ? "closed" : "open", merged:s.prState === "MERGED", merged_at:s.prState === "MERGED" ? "2026-11-05T17:34:55Z" : null, merge_commit_sha:s.landed, html_url:repository.html_url + "/pull/42", base:{ref:"main",sha:s.landed,repo:repository},head:{ref:"fix/task",sha:s.head,repo:repository} }));
  process.exit(0);
}
throw Error("Unexpected GitHub call: " + args.join(" "));
`,
    { mode: 0o755 },
  );
  const socket = join(root, "c.sock");
  await command.lifetime.acquire(async (rejectAfterCleanup) => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const cleanup = async () => {
      for (const client of sockets.clients) {
        client.terminate();
      }
      await Promise.all([
        new Promise<void>((resolve) => {
          sockets.close(() => resolve());
        }),
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
      ]);
    };
    sockets.on("connection", (client) => {
      if (state.unavailable) {
        client.terminate();
        return;
      }
      client.on("message", (data) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        const request = JSON.parse(bytes.toString("utf8"));
        appendFileSync(calls, JSON.stringify(request) + "\n");
        if (request.id === undefined) {
          return;
        }
        let result;
        switch (request.method) {
          case "initialize":
            result = { userAgent: "fixture", platformFamily: "unix", platformOs: "test" };
            break;
          case "thread/loaded/list":
            result = request.params?.cursor
              ? { data: [peer], nextCursor: null }
              : { data: [owner], nextCursor: "second-page" };
            break;
          case "thread/read": {
            expect(request.params.includeTurns).toBe(false);
            const thread = state.threads[request.params.threadId];
            if (!thread) {
              client.send(
                JSON.stringify({
                  id: request.id,
                  error: { code: -32000, message: "Unknown thread" },
                }),
              );
              return;
            }
            result = { thread };
            break;
          }
          case "thread/attachmentOwner/list":
            result = { data: [], nextCursor: null };
            break;
          case "thread/attachment/list":
            result = { data: state.attachments[request.params.threadId] ?? [], nextCursor: null };
            break;
          default:
            throw new Error("Unexpected Codex method: " + request.method);
        }
        client.send(JSON.stringify({ id: request.id, result }));
      });
    });
    try {
      server.listen(socket);
      await once(server, "listening");
    } catch (error) {
      return rejectAfterCleanup(error, cleanup);
    }
    return { cleanup };
  });
  const args = [
    "gc",
    "--pr",
    "42",
    "--worktree",
    worktree,
    "--expected-head",
    head,
    "--finalized-task",
    owner,
    "--codex-socket",
    socket,
    ...[...artifacts, join(worktree, "node_modules")].flatMap((path) => ["--artifact", path]),
  ];
  const run = async (extra: string[] = [], overrides: NodeJS.ProcessEnv = {}) => {
    const result = await command.run(join(repo, "scripts/pr"), [...args, ...extra], {
      cwd: repo,
      env: { ...env, ...overrides },
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const runArtifacts = async (selected: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const result = await command.run(
      join(repo, "scripts/pr"),
      [
        "gc",
        "--pr",
        "42",
        "--expected-head",
        head,
        "--finalized-task",
        owner,
        "--codex-socket",
        socket,
        ...selected.flatMap((path) => ["--artifact", path]),
      ],
      { cwd: repo, env: { ...env, ...overrides } },
    );
    return { ...result, output: result.stdout + result.stderr };
  };
  const preserved = () => {
    expect(readFileSync(join(shared, "keep"), "utf8")).toBe("shared dependencies\n");
    expect(readFileSync(join(unrelated, "keep"), "utf8")).toBe("unrelated proof\n");
    expect(git("-C", template, "rev-parse", "HEAD")).toBe(base);
    expect(git("rev-parse", "refs/heads/fix/task")).toBe(head);
    expect(git("for-each-ref", "refs/openclaw/pr-merge-outcomes/")).toBe("");
  };
  return {
    root,
    repo,
    env,
    worktree,
    artifacts,
    template,
    socket,
    head,
    state,
    save,
    run,
    runArtifacts,
    preserved,
    git,
    args,
    calls,
    bin,
  };
}

describePosix("scripts/pr finalized-task closeout", () => {
  it("dry-runs, closes an externally squash-merged custom worktree, and safely repeats", async ({
    f,
  }) => {
    expect(f.head).not.toBe(f.state.landed);
    const registrations = f.git("worktree", "list", "--porcelain");
    const refs = f.git("show-ref");
    const dry = await f.run(["--dry-run"]);
    expect(dry.status, dry.output).toBe(0);
    for (const path of [f.worktree, ...f.artifacts]) {
      expect(dry.output).toContain(path);
    }
    expect(f.git("worktree", "list", "--porcelain")).toBe(registrations);
    expect(f.git("show-ref")).toBe(refs);
    expect(lstatSync(join(f.worktree, "node_modules")).isSymbolicLink()).toBe(true);
    for (const path of f.artifacts) {
      expect(existsSync(join(path, "proof.txt"))).toBe(true);
    }
    const actual = await f.run();
    expect(actual.status, actual.output).toBe(0);
    for (const path of [f.worktree, ...f.artifacts]) {
      expect(existsSync(path)).toBe(false);
    }
    expect(f.git("worktree", "list", "--porcelain")).not.toContain(f.worktree + "\n");
    f.preserved();
    const retry = await f.run();
    expect(retry.status, retry.output).toBe(0);
    f.preserved();
    const requests = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.some(
        (request) =>
          request.method === "thread/loaded/list" && request.params.cursor === "second-page",
      ),
    ).toBe(true);
  });

  it("preserves ignored and untracked files that the task did not select", async ({ f }) => {
    for (const file of [".env", "unpublished.txt"]) {
      const path = join(f.worktree, file);
      writeFileSync(path, "unselected bytes\n");
      const result = await f.run();
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(file);
      expect(readFileSync(path, "utf8")).toBe("unselected bytes\n");
      for (const artifact of f.artifacts) {
        expect(existsSync(join(artifact, "proof.txt"))).toBe(true);
      }
      unlinkSync(path);
    }
    f.preserved();
  });

  it("preserves tracked root artifacts and index-only changes in the worktree", async ({ f }) => {
    const proof = join(f.artifacts[2]!, "proof.txt");
    f.git("add", "-f", proof);
    const tracked = await f.run();
    expect(tracked.status, tracked.output).not.toBe(0);
    expect(tracked.output).toMatch(/tracked source/iu);
    expect(readFileSync(proof, "utf8")).toBe("task-owned proof\n");
    f.git("reset", "-q", "HEAD", "--", proof);
    const source = join(f.worktree, "tracked-result.txt");
    writeFileSync(source, "staged unpublished work\n");
    f.git("-C", f.worktree, "add", "tracked-result.txt");
    writeFileSync(source, "completed source change\n");
    const staged = await f.run();
    expect(staged.status, staged.output).not.toBe(0);
    expect(staged.output).toMatch(/tracked changes/iu);
    expect(readFileSync(source, "utf8")).toBe("completed source change\n");
    expect(f.git("-C", f.worktree, "show", ":tracked-result.txt")).toBe("staged unpublished work");
    for (const artifact of f.artifacts) {
      expect(existsSync(join(artifact, "proof.txt"))).toBe(true);
    }
    f.preserved();
  });

  it("preserves tracked root artifacts selected through a filesystem case alias", async ({ f }) => {
    const original = f.artifacts[2]!;
    const canonical = join(f.repo, ".artifacts", "Task-Proof");
    renameSync(original, canonical);
    f.git("add", "-f", canonical);
    const aliasExists = existsSync(original);
    const result = await f.runArtifacts([original]);
    if (aliasExists) {
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/canonical|tracked/iu);
    } else {
      expect(result.status, result.output).toBe(0);
    }
    expect(readFileSync(join(canonical, "proof.txt"), "utf8")).toBe("task-owned proof\n");
    f.preserved();
  });

  it("preserves shared dependencies, then closes only explicitly selected root artifacts", async ({
    f,
  }) => {
    const proof = f.artifacts[2]!;
    const dependencyLink = join(f.template, "node_modules");
    symlinkSync(proof, dependencyLink);
    const shared = await f.run();
    expect(shared.status, shared.output).not.toBe(0);
    expect(shared.output).toMatch(/shared dependencies/iu);
    expect(shared.output).toContain(f.template);
    expect(readFileSync(join(proof, "proof.txt"), "utf8")).toBe("task-owned proof\n");
    unlinkSync(dependencyLink);
    symlinkSync(join(f.worktree, "scripts"), dependencyLink);
    const checkout = await f.run();
    expect(checkout.status, checkout.output).not.toBe(0);
    expect(checkout.output).toMatch(/shared dependencies/iu);
    expect(readFileSync(join(proof, "proof.txt"), "utf8")).toBe("task-owned proof\n");
    expect(existsSync(join(f.worktree, "scripts", "pr"))).toBe(true);
    unlinkSync(dependencyLink);
    const result = await f.runArtifacts([proof]);
    expect(result.status, result.output).toBe(0);
    expect(existsSync(proof)).toBe(false);
    expect(f.git("-C", f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    for (const artifact of f.artifacts.slice(0, 2)) {
      expect(existsSync(join(artifact, "proof.txt"))).toBe(true);
    }
    expect(lstatSync(join(f.worktree, "node_modules")).isSymbolicLink()).toBe(true);
    f.preserved();
  });

  it("preserves an installation shared through a package link in another checkout", async ({
    f,
  }) => {
    const scope = join(f.template, "node_modules", "@fixture");
    mkdirSync(scope, { recursive: true });
    const consumer = join(scope, "package");
    symlinkSync(f.artifacts[2]!, consumer);
    const result = await f.run();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/shared dependencies/iu);
    expect(readFileSync(join(consumer, "proof.txt"), "utf8")).toBe("task-owned proof\n");
    expect(existsSync(f.worktree)).toBe(true);
    f.preserved();
  });

  for (const kind of ["directory", "symlink"] as const) {
    it(`preserves a selected ${kind} inside another checkout's shared dependencies`, async ({
      f,
    }) => {
      const installation = f.artifacts[2]!;
      const packages = join(installation, ".pnpm");
      mkdirSync(packages);
      writeFileSync(join(packages, "keep"), "shared package bytes\n");
      const link = join(installation, "package-link");
      symlinkSync(packages, link);
      symlinkSync(installation, join(f.template, "node_modules"));
      const result = await f.runArtifacts([kind === "directory" ? packages : link]);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/shared dependencies/iu);
      expect(result.output).toContain(f.template);
      expect(readFileSync(join(packages, "keep"), "utf8")).toBe("shared package bytes\n");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      f.preserved();
    });
  }

  for (const kind of ["directory", "symlink"] as const) {
    it(`preserves a selected ${kind} inside another registered checkout`, async ({ f }) => {
      const checkout = join(f.repo, ".artifacts", "other-checkout");
      f.git("worktree", "add", "-q", "--detach", checkout, f.head);
      const source = join(checkout, "scripts");
      const wrapper = readFileSync(join(source, "pr"), "utf8");
      const link = join(source, "task-link");
      symlinkSync(f.artifacts[2]!, link);
      const result = await f.runArtifacts([kind === "directory" ? source : link]);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/registered worktree|native owner/iu);
      expect(result.output).toContain(checkout);
      expect(readFileSync(join(source, "pr"), "utf8")).toBe(wrapper);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(f.git("-C", checkout, "rev-parse", "HEAD")).toBe(f.head);
      f.preserved();
    });
  }

  it("preserves nested credential stores and unlinks protected-store symlinks safely", async ({
    f,
  }) => {
    const parent = join(f.artifacts[2]!, "proof-parent");
    const store = join(parent, "nested", ".ssh");
    mkdirSync(store, { recursive: true });
    const credential = join(store, "synthetic-key");
    writeFileSync(credential, "synthetic credential fixture\n");
    const refused = await f.runArtifacts([parent]);
    expect(refused.status, refused.output).not.toBe(0);
    expect(readFileSync(credential, "utf8")).toBe("synthetic credential fixture\n");
    const protectedStore = join(f.env.HOME!, ".ssh");
    mkdirSync(protectedStore);
    writeFileSync(join(protectedStore, "keep"), "preserved credential fixture\n");
    const link = join(f.artifacts[2]!, "protected-store-link");
    symlinkSync(protectedStore, link);
    const result = await f.runArtifacts([link]);
    expect(result.status, result.output).toBe(0);
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(protectedStore, "keep"), "utf8")).toBe(
      "preserved credential fixture\n",
    );
    const state = join(f.artifacts[2]!, "state");
    const credentials = join(state, "credentials");
    mkdirSync(credentials, { recursive: true });
    writeFileSync(join(credentials, "keep"), "configured credential fixture\n");
    const configured = await f.runArtifacts([credentials], { OPENCLAW_STATE_DIR: state });
    expect(configured.status, configured.output).not.toBe(0);
    expect(readFileSync(join(credentials, "keep"), "utf8")).toBe("configured credential fixture\n");
    f.preserved();
  });

  it("closes nested artifact selections while preserving unknown siblings and empty directories", async ({
    f,
  }) => {
    const parent = f.artifacts[0]!;
    const proof = join(parent, "proof");
    mkdirSync(proof);
    renameSync(join(parent, "proof.txt"), join(proof, "proof.txt"));
    f.args[f.args.indexOf(parent)] = proof;
    for (const [unknown, directory] of [
      [join(parent, "sibling.txt"), false],
      [join(f.worktree, "unrelated-empty"), true],
    ] as const) {
      if (directory) {
        mkdirSync(unknown);
      } else {
        writeFileSync(unknown, "unknown sibling\n");
      }
      const refused = await f.run();
      expect(refused.status, refused.output).not.toBe(0);
      expect(existsSync(unknown)).toBe(true);
      expect(readFileSync(join(proof, "proof.txt"), "utf8")).toBe("task-owned proof\n");
      if (directory) {
        rmdirSync(unknown);
      } else {
        unlinkSync(unknown);
      }
    }
    const result = await f.run();
    expect(result.status, result.output).toBe(0);
    expect(existsSync(f.worktree)).toBe(false);
    f.preserved();
  });

  it("blocks an idle loaded session whose working directory uses selected proof", async ({ f }) => {
    f.state.threads[peer]!.cwd = join(f.worktree, "node_modules");
    f.save();
    const symlink = await f.run();
    expect(symlink.status, symlink.output).not.toBe(0);
    expect(symlink.output).toContain(peer);
    expect(lstatSync(join(f.worktree, "node_modules")).isSymbolicLink()).toBe(true);
    for (const artifact of f.artifacts) {
      expect(existsSync(join(artifact, "proof.txt"))).toBe(true);
    }
    f.state.threads[peer]!.cwd = f.artifacts[2]!;
    f.save();
    const result = await f.run();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(peer);
    expect(existsSync(f.worktree)).toBe(true);
    f.preserved();
  });

  it("accepts unrelated native worktree attachments and preserves live references", async ({
    f,
  }) => {
    for (const attachmentType of ["worktree", "archived_worktree"]) {
      for (const reference of [f.template, f.worktree]) {
        const worktree = { root: reference, workspaceRoot: reference };
        f.state.attachments[peer] = [
          {
            attachmentType,
            payload: attachmentType === "archived_worktree" ? { worktree } : worktree,
          },
        ];
        f.save();
        const result = await f.run(["--dry-run"]);
        if (reference === f.template) {
          expect(result.status, result.output).toBe(0);
        } else {
          expect(result.status, result.output).not.toBe(0);
          expect(result.output).toContain(peer);
        }
        for (const artifact of f.artifacts) {
          expect(existsSync(join(artifact, "proof.txt"))).toBe(true);
        }
      }
    }
    f.preserved();
  });

  it("blocks unavailable transport, unknown owners, and incomplete metadata", async ({ f }) => {
    f.state.unavailable = true;
    f.save();
    const unavailable = await f.run();
    expect(unavailable.status, unavailable.output).not.toBe(0);
    f.state.unavailable = false;
    f.save();
    const missing = "33333333-3333-4333-8333-333333333333";
    const unknown = await f.run(["--known-thread", missing]);
    expect(unknown.status, unknown.output).not.toBe(0);
    expect(unknown.output).toContain("thread/read");
    Object.assign(f.state.threads[peer]!, { environments: null });
    f.save();
    const incomplete = await f.run();
    expect(incomplete.status, incomplete.output).not.toBe(0);
    expect(incomplete.output).toMatch(/environment/iu);
    expect(existsSync(f.worktree)).toBe(true);
    f.preserved();
  });

  it("rechecks the expected head, physical boundaries, and native worktree ownership", async ({
    f,
  }) => {
    f.state.prState = "OPEN";
    f.save();
    const open = await f.run();
    expect(open.status, open.output).not.toBe(0);
    expect(open.output).toMatch(/merged/iu);
    f.state.prState = "MERGED";
    f.save();
    const base = f.git("rev-parse", f.head + "^");
    f.git("-C", f.worktree, "checkout", "--detach", base);
    const changedHead = await f.run();
    expect(changedHead.status, changedHead.output).not.toBe(0);
    expect(changedHead.output).toMatch(/HEAD/iu);
    f.git("-C", f.worktree, "checkout", "fix/task");
    const outside = join(f.root, "outside");
    mkdirSync(join(outside, "proof"), { recursive: true });
    writeFileSync(join(outside, "proof", "keep"), "outside the repository\n");
    const alias = join(f.repo, ".artifacts", "alias");
    symlinkSync(outside, alias);
    const escaped = await f.run(["--artifact", join(alias, "proof")]);
    expect(escaped.status, escaped.output).not.toBe(0);
    expect(escaped.output).toMatch(/boundar|outside/iu);
    expect(readFileSync(join(outside, "proof", "keep"), "utf8")).toBe("outside the repository\n");
    const admin = f.git("-C", f.worktree, "rev-parse", "--absolute-git-dir");
    writeFileSync(
      join(admin, "codex-thread.json"),
      JSON.stringify({ version: 1, ownerThreadId: owner }),
    );
    const managed = await f.run();
    expect(managed.status, managed.output).not.toBe(0);
    expect(managed.output).toMatch(/native owner|Codex-managed/iu);
    expect(existsSync(f.worktree)).toBe(true);
    for (const artifact of f.artifacts) {
      expect(existsSync(join(artifact, "proof.txt"))).toBe(true);
    }
    f.preserved();
  });

  it("preserves unresolved native capture evidence without inventing a receipt", async ({ f }) => {
    mkdirSync(join(f.worktree, ".local"));
    const capture = join(f.worktree, ".local", "merge-output.log");
    writeFileSync(capture, "");
    const result = await f.run(["--artifact", join(f.worktree, ".local")]);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/merge|recovery/iu);
    expect(readFileSync(capture, "utf8")).toBe("");
    f.preserved();
  });

  it("retains a live parent cwd even when cleanup runs from the persistent checkout", async ({
    f,
    command,
  }) => {
    const result = await command.run(
      process.execPath,
      [
        "-e",
        `
const {spawnSync} = require("node:child_process");
const [repo,args] = process.argv.slice(1);
const result = spawnSync(repo + "/scripts/pr", JSON.parse(args), {cwd:repo,env:process.env,encoding:"utf8"});
process.stdout.write(JSON.stringify({status:result.status,output:result.stdout+result.stderr}));
`,
        f.repo,
        JSON.stringify(f.args),
      ],
      { cwd: f.worktree, env: f.env },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const cleanup = JSON.parse(result.stdout);
    expect(cleanup.status, cleanup.output).not.toBe(0);
    expect(cleanup.output).toMatch(/live process|working director|holder/iu);
    expect(existsSync(f.worktree)).toBe(true);
    f.preserved();
  });

  it("reports partial completion and retries after native Git removal becomes available", async ({
    f,
  }) => {
    const selectedGit = join(f.bin, "selected-git");
    writeFileSync(
      selectedGit,
      `#!${process.execPath}
const {spawnSync} = require("node:child_process");
const args = process.argv.slice(2);
if (args.some((arg,index) => arg === "worktree" && args[index+1] === "remove")) {
  process.stderr.write("Synthetic native removal failure\\n"); process.exit(19);
}
const child = spawnSync("git",args,{stdio:"inherit",env:process.env});
process.exit(child.status ?? 1);
`,
      { mode: 0o755 },
    );
    const first = await f.run([], { OPENCLAW_PR_GIT: selectedGit });
    expect(first.status, first.output).not.toBe(0);
    expect(first.output).toContain("Synthetic native removal failure");
    expect(existsSync(f.worktree)).toBe(true);
    for (const path of f.artifacts) {
      expect(existsSync(path)).toBe(false);
      expect(first.output).toContain(`removed artifact ${path}`);
    }
    f.preserved();
    const retry = await f.run();
    expect(retry.status, retry.output).toBe(0);
    expect(existsSync(f.worktree)).toBe(false);
    f.preserved();
  });
});
