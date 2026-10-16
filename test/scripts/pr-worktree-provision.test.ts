import * as fs from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWorktreeFilesystemBackend } from "../../src/agents/worktrees/filesystem-backend.js";
import { listTemplatesAsync } from "../../src/agents/worktrees/template-registry-async.js";
import { closeStateDatabaseForTest } from "../../src/test-utils/database-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
const describePosix = process.platform === "win32" ? describe.skip : describe;

function coldFixture() {
  const f = createMainRefreshFixture(tempDirs.make("openclaw-pr-provision-"), {
    perWorktreeConfig: false,
    precreateWorktree: false,
  });
  f.env.OPENCLAW_STATE_DIR = join(f.root, "state");
  f.env.OPENCLAW_CONFIG_PATH = join(f.root, "config.json");
  fs.writeFileSync(f.env.OPENCLAW_CONFIG_PATH, "{}\n");
  const run = (...args: Parameters<typeof f.run>) => {
    const result = f.run(...args);
    f.assertPrivateHandoffVerified();
    return result;
  };
  return {
    ...f,
    run,
    canonicalGit: (...args: string[]) => f.git(f.canonical, ...args),
    subject: (worktree = f.worktree) =>
      fs.readFileSync(join(worktree, "src", "subject.ts"), "utf8"),
    reviewInit(success = true) {
      const result = run("review-init");
      expect(result.status === 0, result.stderr).toBe(success);
      return result;
    },
    expectNoTemplates(parent = join(f.canonical, ".worktrees")) {
      expect(fs.existsSync(join(parent, ".templates"))).toBe(false);
    },
    expectUnlocked() {
      expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
    },
    expectMainTree() {
      expect(f.git(f.worktree, "write-tree")).toBe(
        f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
      );
    },
  };
}

const indexPath = (f: ReturnType<typeof coldFixture>, worktree: string) =>
  f.git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index");

function expectSeed(f: ReturnType<typeof coldFixture>, pr = 42) {
  const worktree = join(f.canonical, ".worktrees", `pr-${pr}`);
  expect(f.git(worktree, "symbolic-ref", "HEAD")).toBe(`refs/heads/temp/pr-${pr}`);
  expect(f.git(worktree, "rev-parse", "HEAD")).toBe(f.main);
  expect(f.git(f.canonical, "rev-parse", `refs/heads/temp/pr-${pr}`)).toBe(f.main);
  return worktree;
}

function nextPr(f: ReturnType<typeof coldFixture>, pr: number, route?: string) {
  f.configure({
    metadata: {
      ...f.metadata,
      number: pr,
      url: `https://github.com/fixture/repo/pull/${pr}`,
    },
  });
  const result = f.run(["review-init", String(pr)]);
  expect(result.status, result.stderr).toBe(0);
  if (route) {
    expect(result.stderr).toContain(`PR source checkout: ${route}.`);
  }
  return join(f.canonical, ".worktrees", `pr-${pr}`);
}

function installCheckoutHook(f: ReturnType<typeof coldFixture>, body: string) {
  f.git(f.canonical, "config", "--unset", "core.hooksPath");
  const hook = join(f.canonical, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(hook, 0o755);
}

describePosix("native PR source provisioning", () => {
  let f: ReturnType<typeof coldFixture>;
  beforeEach(() => {
    f = coldFixture();
  });
  it("keeps disabled-acceleration seed, private checkpoint, and cleanup custody", () => {
    fs.writeFileSync(f.env.OPENCLAW_CONFIG_PATH!, '{"worktreeAcceleration":false}\n');
    const shared = f.canonicalGit("rev-parse", "refs/remotes/origin/main");
    f.reviewInit();
    expectSeed(f);
    expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(f.main);
    expect(f.canonicalGit("rev-parse", "refs/remotes/origin/main")).toBe(shared);
    f.expectUnlocked();
    f.expectNoTemplates();
  });

  it("preserves a symlinked parent through native Git with acceleration enabled", () => {
    fs.writeFileSync(f.env.OPENCLAW_CONFIG_PATH!, JSON.stringify({ worktreeAcceleration: true }));
    const preload = join(f.root, "native-provision-imports.mjs");
    const guardReceipt = join(f.root, "native-provision-imports.txt");
    fs.writeFileSync(
      preload,
      `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
if (process.argv[1]?.endsWith("/worktree-provision.mts")) {
  registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/src/config/config.ts")) {
      throw new Error("Native Git provisioning must not load acceleration configuration.");
    }
    return nextLoad(url, context);
  } });
  appendFileSync(${JSON.stringify(guardReceipt)}, String(process.pid) + "\\n");
}
`,
    );
    f.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href} ${f.env.NODE_OPTIONS}`;
    const parent = join(f.canonical, ".worktrees");
    const physicalParent = join(f.root, "pr-worktrees");
    fs.rmdirSync(parent);
    fs.mkdirSync(physicalParent);
    fs.symlinkSync(physicalParent, parent, "dir");
    const result = f.reviewInit();
    expect(result.stderr).toContain("PR source checkout: Git checkout.");
    expect(fs.readFileSync(guardReceipt, "utf8")).toMatch(/^[1-9]\d*\n$/);
    expectSeed(f);
    expect(f.git(f.worktree, "rev-parse", "--show-toplevel")).toBe(join(physicalParent, "pr-42"));
    expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(f.main);
    f.expectUnlocked();
    f.expectNoTemplates(physicalParent);
  });

  it.runIf(process.platform === "linux")(
    "keeps native Git provisioning on an unsupported source filesystem",
    async (context) => {
      // A clone-capable fixture volume cannot supply this acceptance cell.
      const backend = await detectWorktreeFilesystemBackend(f.canonical, {
        commitGuard() {},
      });
      if (backend) {
        context.skip();
        return;
      }
      const result = f.reviewInit();
      expect(result.stderr).toContain("PR source checkout: Git checkout.");
      expectSeed(f);
      f.expectMainTree();
      expect(fs.existsSync(join(f.worktree, "scripts", "pr"))).toBe(true);
      f.expectNoTemplates();
    },
  );

  it.each(["count", "parameters"] as const)(
    "preserves command-scoped safe.directory through cold provisioning (%s transport)",
    (transport) => {
      // Local upload-pack drops client command-scope config; trust only its bare remote.
      f.env.GIT_CONFIG_GLOBAL = join(f.root, "gitconfig");
      f.git(f.canonical, "config", "--global", "--add", "safe.directory", f.origin);
      f.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
      if (transport === "count") {
        f.env.GIT_CONFIG_COUNT = "1";
        f.env.GIT_CONFIG_KEY_0 = "safe.directory";
        f.env.GIT_CONFIG_VALUE_0 = "*";
      } else {
        f.env.GIT_CONFIG_PARAMETERS = "'safe.directory=*'";
      }
      const result = f.reviewInit();
      expectSeed(f);
      if (transport === "count") {
        expect(result.stderr).toContain("PR source checkout: Git checkout.");
        f.expectNoTemplates();
      }
      expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(f.main);
      f.expectUnlocked();
    },
  );

  it.each([
    "default",
    "absolute",
    "relative",
    "command-scoped",
    "parameter-scoped",
    "branch",
  ] as const)("executes the %s checkout hook once and preserves its tracked edit", (policy) => {
    const hooks =
      policy === "default" ? join(f.canonical, ".git", "hooks") : join(f.root, "configured-hooks");
    const receipt = join(f.root, "configured-hook.txt");
    if (policy !== "default") {
      fs.mkdirSync(hooks);
    }
    const hook = join(hooks, "post-checkout");
    fs.writeFileSync(
      hook,
      `#!/bin/sh
printf '%s\\t%s\\t%s\\t%s\\n' "$PWD" "$1" "$2" "$3" >> "${receipt}"
printf 'hook-owned edit\\n' > src/subject.ts
`,
    );
    fs.chmodSync(hook, 0o755);
    if (policy === "default") {
      f.git(f.canonical, "config", "--unset", "core.hooksPath");
    } else if (policy === "branch") {
      const config = join(f.root, "branch.gitconfig");
      fs.writeFileSync(config, `[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`);
      f.git(f.canonical, "config", "includeIf.onbranch:temp/pr-*.path", config);
      // Detached canonical HEAD cannot reveal the destination's branch-only policy.
      expect(f.git(f.canonical, "config", "--get", "core.hooksPath")).toBe("/dev/null");
    } else if (policy === "command-scoped") {
      f.env.GIT_CONFIG_COUNT = "1";
      f.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
      f.env.GIT_CONFIG_VALUE_0 = hooks;
    } else if (policy === "parameter-scoped") {
      f.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath=${hooks}'`;
    } else {
      // Relative hooks resolve from the checkout in which the hook runs,
      // not from the canonical repository where provisioning begins.
      f.git(
        f.canonical,
        "config",
        "core.hooksPath",
        policy === "relative" ? relative(f.worktree, hooks) : hooks,
      );
    }
    const result = f.reviewInit(false);
    // Relative and branch-only policy activates after entering the new checkout.
    expect(result.stderr).toContain(
      policy === "relative" || policy === "branch"
        ? "the journaled transition did not complete cleanly"
        : "foreign state blocks a new transition",
    );
    expectSeed(f);
    expect(fs.readFileSync(receipt, "utf8")).toBe(
      `${f.worktree}\t${"0".repeat(40)}\t${f.main}\t1\n`,
    );
    expect(f.subject()).toBe("hook-owned edit\n");
    f.expectNoTemplates();
    expect(f.git(f.canonical, "status", "--porcelain")).toBe("");
    f.expectUnlocked();
  });

  it("preserves a caller fsmonitor hook without enabling it in managed Git", () => {
    const monitor = join(f.root, "fsmonitor");
    const receipt = join(f.root, "fsmonitor.txt");
    // Nonzero monitor exits request an ordinary scan, not a fabricated clean index.
    fs.writeFileSync(monitor, `#!/bin/sh\nprintf '%s\\n' "$PWD" >> "${receipt}"\nexit 1\n`);
    fs.chmodSync(monitor, 0o755);
    f.git(f.canonical, "config", "core.fsmonitor", monitor);
    const result = f.reviewInit();
    expect(result.stderr).toContain("PR source checkout: Git checkout.");
    expect(fs.readFileSync(receipt, "utf8").trim().split("\n")).toContain(f.worktree);
    expectSeed(f);
    expect(f.git(f.worktree, "config", "--get", "core.fsmonitor")).toBe(monitor);
    f.expectNoTemplates();
  });

  it("preserves the caller branch and initialized checkout after a nonzero hook exit", () => {
    installCheckoutHook(f, "printf 'retained hook evidence\\n' > hook-evidence.txt\nexit 31");
    f.reviewInit(false);
    expectSeed(f);
    expect(fs.readFileSync(join(f.worktree, "hook-evidence.txt"), "utf8")).toBe(
      "retained hook evidence\n",
    );
    f.expectUnlocked();
  });

  it("does not repair a caller seed moved by a checkout hook", () => {
    installCheckoutHook(f, `git update-ref refs/heads/temp/pr-42 ${f.head} ${f.main}`);
    const result = f.reviewInit(false);
    expect(result.stderr).toMatch(/identity changed|seed branch moved/);
    expect(f.canonicalGit("rev-parse", "refs/heads/temp/pr-42")).toBe(f.head);
    expect(f.git(f.worktree, "symbolic-ref", "HEAD")).toBe("refs/heads/temp/pr-42");
    f.expectMainTree();
  });

  it.each(["replaced", "deleted"] as const)(
    "retains native checkout evidence when a hook leaves the PR lock %s",
    (change) => {
      const lockRef = "refs/openclaw/pr-operation-locks/42";
      const receipt = join(f.root, "hook-lock-change.txt");
      const changeLock =
        change === "replaced"
          ? `replacement=$(printf 'successor-owned lock evidence\\n' | git hash-object -w --stdin) || exit 32
git update-ref --no-deref "${lockRef}" "$replacement" "$previous" || exit 33
printf '%s\\n' "$replacement" > "${receipt}"`
          : `git update-ref --no-deref -d "${lockRef}" "$previous" || exit 34
printf 'deleted\\n' > "${receipt}"`;
      installCheckoutHook(
        f,
        `previous=$(git rev-parse --verify "${lockRef}") || exit 31
printf 'hook-owned state after lock loss\\n' > src/subject.ts
${changeLock}`,
      );

      const result = f.reviewInit(false);
      expect(result.stderr).toContain("PR operation lock changed or is unreadable");
      expectSeed(f);
      expect(f.subject()).toBe("hook-owned state after lock loss\n");
      f.expectMainTree();
      expect(f.canonicalGit("worktree", "list", "--porcelain")).toContain(f.worktree);
      expect(f.canonicalGit("status", "--porcelain")).toBe("");
      f.expectNoTemplates();
      const observed = fs.readFileSync(receipt, "utf8").trim();
      if (change === "replaced") {
        expect(observed).toMatch(/^[0-9a-f]{40}$/);
        expect(f.canonicalGit("rev-parse", "--verify", lockRef)).toBe(observed);
        expect(f.canonicalGit("cat-file", "blob", observed)).toBe("successor-owned lock evidence");
      } else {
        expect(observed).toBe("deleted");
        expect(f.canonicalGit("for-each-ref", "--format=%(refname)", lockRef)).toBe("");
      }
    },
  );

  // Only an actual accelerated host can prove this cell; a skip is not APFS proof.
  it.skipIf(process.platform !== "darwin")(
    "materializes full cold/warm PR siblings, then preserves native sparse transitions",
    async () => {
      const first = f.reviewInit();
      const templates = join(f.canonical, ".worktrees", ".templates");
      expect(fs.existsSync(templates), first.stderr).toBe(true);
      const templateNames = fs.readdirSync(templates).toSorted();
      expect(templateNames.length).toBeGreaterThan(0);
      expect(first.stderr).toContain("PR source checkout: filesystem template clone.");
      const template = (
        await listTemplatesAsync({
          ...f.env,
          OPENCLAW_STATE_DIR: join(f.canonical, ".local", "pr-state"),
        })
      ).find((entry) => entry.sourceCommit === f.main);
      expect(template).toMatchObject({ backend: "apfs", status: "ready" });
      const warm = nextPr(f, 43, "filesystem template clone");
      expect(fs.readdirSync(templates).toSorted()).toEqual(templateNames);
      expectSeed(f, 43);
      expect(indexPath(f, warm)).not.toBe(indexPath(f, f.worktree));
      fs.writeFileSync(join(f.worktree, "src", "subject.ts"), "first sibling edit\n");
      expect(f.subject(warm)).toBe("export const subject = 'base';\n");
      fs.writeFileSync(join(warm, "src", "subject.ts"), "warm sibling edit\n");

      // Keep transition order without resetting common config.
      const sparse = nextPr(f, 44);
      f.git(sparse, "sparse-checkout", "set", "--cone", "src");
      const origins = f.git(sparse, "config", "--show-origin", "--show-scope", "--list");
      expect(origins).toContain("extensions.worktreeconfig=true");
      expect(f.git(sparse, "config", "--bool", "core.sparseCheckout")).toBe("true");
      const whileSparse = nextPr(f, 45, "Git checkout");
      expect(fs.existsSync(join(whileSparse, "scripts", "pr"))).toBe(true);
      expect(f.git(sparse, "config", "--bool", "core.sparseCheckout")).toBe("true");
      f.git(sparse, "sparse-checkout", "disable");
      const afterDisable = nextPr(f, 46, "Git checkout");
      expect(fs.existsSync(join(afterDisable, "scripts", "pr"))).toBe(true);
      const laterSparse = nextPr(f, 47, "Git checkout");
      f.git(laterSparse, "sparse-checkout", "set", "--cone", "src");
      expect(f.git(laterSparse, "config", "--bool", "core.sparseCheckout")).toBe("true");
      expect(f.git(sparse, "config", "--bool", "core.sparseCheckout")).toBe("false");
      expect(indexPath(f, laterSparse)).not.toBe(indexPath(f, sparse));
      expect(fs.readdirSync(templates).toSorted()).toEqual(templateNames);
      expect(f.canonicalGit("config", "--bool", "extensions.worktreeConfig")).toBe("true");
      expect([f.subject(), f.subject(warm), f.subject(template!.path)]).toEqual([
        "first sibling edit\n",
        "warm sibling edit\n",
        "export const subject = 'base';\n",
      ]);
      for (const pr of [43, 44, 45, 46, 47]) {
        expectSeed(f, pr);
      }
    },
  );
});
