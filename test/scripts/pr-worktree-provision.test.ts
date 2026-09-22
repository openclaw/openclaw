import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorktreeFilesystemBackend } from "../../src/agents/worktrees/filesystem-backend.js";
import { listTemplates } from "../../src/agents/worktrees/template-registry.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { collectEagerRuntimeImportClosure } from "./eager-import-closure.test-support.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";
import { copyPrWrapperSources } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

it("extracts the complete eager runtime import closure without duplicate wrapper components", () => {
  const extracted = tempDirs.make("openclaw-pr-import-closure-");
  const components = copyPrWrapperSources(extracted);
  expect(components.filter((component, index) => components.indexOf(component) !== index)).toEqual(
    [],
  );
  const files = readdirSync(extracted, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(extracted, join(entry.parentPath, entry.name)));
  expect(
    collectEagerRuntimeImportClosure(files).filter((file) => !existsSync(join(extracted, file))),
  ).toEqual([]);
});

function coldFixture(perWorktreeConfig = true) {
  const f = createMainRefreshFixture(tempDirs.make("openclaw-pr-provision-"), {
    perWorktreeConfig,
  });
  // Remove only this harness's disposable precreated checkout, before review-init.
  f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
  f.env.OPENCLAW_STATE_DIR = join(f.root, "state");
  f.env.OPENCLAW_CONFIG_PATH = join(f.root, "config.json");
  writeFileSync(f.env.OPENCLAW_CONFIG_PATH, "{}\n");
  return f;
}

function expectSeed(f: ReturnType<typeof coldFixture>, pr = 42) {
  const worktree = join(f.canonical, ".worktrees", `pr-${pr}`);
  expect(f.git(worktree, "symbolic-ref", "HEAD")).toBe(`refs/heads/temp/pr-${pr}`);
  expect(f.git(worktree, "rev-parse", "HEAD")).toBe(f.main);
  expect(f.git(f.canonical, "rev-parse", `refs/heads/temp/pr-${pr}`)).toBe(f.main);
  return worktree;
}

function nextPr(f: ReturnType<typeof coldFixture>, pr: number) {
  f.configure({
    metadata: {
      ...f.metadata,
      number: pr,
      url: `https://github.com/fixture/repo/pull/${pr}`,
    },
  });
  const result = f.run(["review-init", String(pr)]);
  expect(result.status, result.stderr).toBe(0);
  return { worktree: join(f.canonical, ".worktrees", `pr-${pr}`), stderr: result.stderr };
}

describePosix("native PR source provisioning", () => {
  it("keeps disabled-acceleration seed, private checkpoint, and cleanup custody", () => {
    const f = coldFixture(false);
    writeFileSync(f.env.OPENCLAW_CONFIG_PATH!, '{"worktreeAcceleration":false}\n');
    const shared = f.git(f.canonical, "rev-parse", "refs/remotes/origin/main");
    const result = f.run("review-init");
    expect(result.status, result.stderr).toBe(0);
    expectSeed(f);
    expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(f.main);
    expect(f.git(f.canonical, "rev-parse", "refs/remotes/origin/main")).toBe(shared);
    expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
    expect(existsSync(join(f.canonical, ".worktrees", ".templates"))).toBe(false);
  });

  it.each([false, true])(
    "preserves a symlinked parent through native Git (acceleration=%s)",
    (acceleration) => {
      const f = coldFixture(false);
      writeFileSync(
        f.env.OPENCLAW_CONFIG_PATH!,
        JSON.stringify({ worktreeAcceleration: acceleration }),
      );
      const preload = join(f.root, "native-provision-imports.mjs");
      writeFileSync(
        preload,
        `import { registerHooks } from "node:module";
if (process.argv[1]?.endsWith("/worktree-provision.mts")) {
  registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/src/config/config.ts")) {
      throw new Error("Native Git provisioning must not load acceleration configuration.");
    }
    return nextLoad(url, context);
  } });
}
`,
      );
      f.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
      const parent = join(f.canonical, ".worktrees");
      const physicalParent = join(f.root, "pr-worktrees");
      rmdirSync(parent);
      mkdirSync(physicalParent);
      symlinkSync(physicalParent, parent, "dir");
      const result = f.run("review-init");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("PR source checkout: Git checkout.");
      expectSeed(f);
      expect(f.git(f.worktree, "rev-parse", "--show-toplevel")).toBe(join(physicalParent, "pr-42"));
      expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(f.main);
      expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
      expect(existsSync(join(physicalParent, ".templates"))).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps native Git provisioning on an unsupported source filesystem",
    async (context) => {
      const f = coldFixture(false);
      // Probe the real fixture volume, not a mocked unsupported backend. A
      // clone-capable Linux volume cannot supply this acceptance cell.
      const backend = await detectWorktreeFilesystemBackend(f.canonical, {
        commitGuard() {},
      });
      if (backend) {
        context.skip();
        return;
      }
      const result = f.run("review-init");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("PR source checkout: Git checkout.");
      expectSeed(f);
      expect(f.git(f.worktree, "write-tree")).toBe(
        f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
      );
      expect(existsSync(join(f.worktree, "scripts", "pr"))).toBe(true);
      expect(existsSync(join(f.canonical, ".worktrees", ".templates"))).toBe(false);
    },
  );

  it.each(["count", "parameters"] as const)(
    "preserves command-scoped safe.directory through cold provisioning (%s transport)",
    (transport) => {
      const f = coldFixture(false);
      // Git's ownership fixture requires actual command-scope authorization,
      // without changing filesystem ownership or global configuration.
      f.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
      if (transport === "count") {
        f.env.GIT_CONFIG_COUNT = "1";
        f.env.GIT_CONFIG_KEY_0 = "safe.directory";
        f.env.GIT_CONFIG_VALUE_0 = "*";
      } else {
        f.env.GIT_CONFIG_PARAMETERS = "'safe.directory=*'";
      }
      const result = f.run("review-init");
      expect(result.status, result.stderr).toBe(0);
      expectSeed(f);
      if (transport === "count") {
        expect(result.stderr).toContain("PR source checkout: Git checkout.");
        expect(existsSync(join(f.canonical, ".worktrees", ".templates"))).toBe(false);
      }
      expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(f.main);
      expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
    },
  );

  it("lets Git execute the default checkout hook exactly once and preserves its tracked edit", () => {
    const f = coldFixture(false);
    f.git(f.canonical, "config", "--unset", "core.hooksPath");
    const hook = join(f.canonical, ".git", "hooks", "post-checkout");
    const receipt = join(f.root, "post-checkout.txt");
    writeFileSync(
      hook,
      `#!/bin/sh
printf '%s\\t%s\\t%s\\t%s\\n' "$PWD" "$1" "$2" "$3" >> "${receipt}"
printf 'hook-owned edit\\n' > src/subject.ts
`,
    );
    chmodSync(hook, 0o755);
    const result = f.run("review-init");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("foreign state blocks a new transition");
    expectSeed(f);
    expect(readFileSync(join(f.worktree, "src", "subject.ts"), "utf8")).toBe("hook-owned edit\n");
    const calls = readFileSync(receipt, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.split("\t")).toEqual([f.worktree, "0".repeat(40), f.main, "1"]);
    expect(f.git(f.canonical, "status", "--porcelain")).toBe("");
    expect(
      f.git(f.canonical, "rev-parse", "--verify", "refs/openclaw/pr-operation-locks/42"),
    ).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(f.canonical, ".worktrees", ".templates"))).toBe(false);
  });

  it.each(["absolute", "relative", "command-scoped", "parameter-scoped"] as const)(
    "preserves %s core.hooksPath policy through native Git",
    (policy) => {
      const f = coldFixture(false);
      const hooks = join(f.root, "configured-hooks");
      const receipt = join(f.root, "configured-hook.txt");
      mkdirSync(hooks);
      const hook = join(hooks, "post-checkout");
      writeFileSync(
        hook,
        `#!/bin/sh
printf '%s\\n' "$PWD" >> "${receipt}"
printf 'configured hook edit\\n' > src/subject.ts
`,
      );
      chmodSync(hook, 0o755);
      if (policy === "command-scoped") {
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
      const result = f.run("review-init");
      expect(result.status).not.toBe(0);
      // Native Git resolves relative hooks only after entering the new checkout.
      // The hook then dirties the explicitly journaled same-seed transition.
      expect(result.stderr).toContain(
        policy === "relative"
          ? "the journaled transition did not complete cleanly"
          : "foreign state blocks a new transition",
      );
      expectSeed(f);
      expect(readFileSync(receipt, "utf8")).toBe(`${f.worktree}\n`);
      expect(readFileSync(join(f.worktree, "src", "subject.ts"), "utf8")).toBe(
        "configured hook edit\n",
      );
      expect(existsSync(join(f.canonical, ".worktrees", ".templates"))).toBe(false);
      expect(f.git(f.canonical, "status", "--porcelain")).toBe("");
      expect(
        f.git(f.canonical, "rev-parse", "--verify", "refs/openclaw/pr-operation-locks/42"),
      ).toMatch(/^[0-9a-f]{40}$/);
    },
  );

  it("honors hook configuration activated only on the new PR branch", () => {
    const f = coldFixture(false);
    const hooks = join(f.root, "branch-hooks");
    const config = join(f.root, "branch.gitconfig");
    const receipt = join(f.root, "branch-hook.txt");
    mkdirSync(hooks);
    const hook = join(hooks, "post-checkout");
    writeFileSync(
      hook,
      `#!/bin/sh
printf '%s\\n' "$PWD" >> "${receipt}"
printf 'branch hook edit\\n' > src/subject.ts
`,
    );
    chmodSync(hook, 0o755);
    writeFileSync(config, `[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`);
    f.git(f.canonical, "config", "includeIf.onbranch:temp/pr-*.path", config);
    // The canonical repository has detached HEAD, so its current policy is
    // insufficient to decide whether the destination's hooks may be disabled.
    expect(f.git(f.canonical, "config", "--get", "core.hooksPath")).toBe("/dev/null");
    const result = f.run("review-init");
    expect(result.status).not.toBe(0);
    // The branch condition activates after native worktree registration.
    expect(result.stderr).toContain("the journaled transition did not complete cleanly");
    expectSeed(f);
    expect(readFileSync(receipt, "utf8")).toBe(`${f.worktree}\n`);
    expect(readFileSync(join(f.worktree, "src", "subject.ts"), "utf8")).toBe("branch hook edit\n");
    expect(existsSync(join(f.canonical, ".worktrees", ".templates"))).toBe(false);
  });

  it("preserves a caller fsmonitor hook without enabling it in managed Git", () => {
    const f = coldFixture(false);
    const monitor = join(f.root, "fsmonitor");
    const receipt = join(f.root, "fsmonitor.txt");
    // Git treats a nonzero monitor exit as a request for an ordinary scan.
    // This records invocation without faking a clean index or monitor token.
    writeFileSync(monitor, `#!/bin/sh\nprintf '%s\\n' "$PWD" >> "${receipt}"\nexit 1\n`);
    chmodSync(monitor, 0o755);
    f.git(f.canonical, "config", "core.fsmonitor", monitor);
    const result = f.run("review-init");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("PR source checkout: Git checkout.");
    expect(readFileSync(receipt, "utf8").trim().split("\n")).toContain(f.worktree);
    expectSeed(f);
    expect(f.git(f.worktree, "config", "--get", "core.fsmonitor")).toBe(monitor);
    expect(existsSync(join(f.canonical, ".worktrees", ".templates"))).toBe(false);
  });

  it("preserves the caller branch and initialized checkout after a nonzero hook exit", () => {
    const f = coldFixture(false);
    f.git(f.canonical, "config", "--unset", "core.hooksPath");
    const hook = join(f.canonical, ".git", "hooks", "post-checkout");
    writeFileSync(
      hook,
      "#!/bin/sh\nprintf 'retained hook evidence\\n' > hook-evidence.txt\nexit 31\n",
    );
    chmodSync(hook, 0o755);
    const result = f.run("review-init");
    expect(result.status).not.toBe(0);
    expectSeed(f);
    expect(readFileSync(join(f.worktree, "hook-evidence.txt"), "utf8")).toBe(
      "retained hook evidence\n",
    );
    expect(
      f.git(f.canonical, "rev-parse", "--verify", "refs/openclaw/pr-operation-locks/42"),
    ).toMatch(/^[0-9a-f]{40}$/);
  });

  it("does not repair a caller seed moved by a checkout hook", () => {
    const f = coldFixture(false);
    f.git(f.canonical, "config", "--unset", "core.hooksPath");
    const hook = join(f.canonical, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ngit update-ref refs/heads/temp/pr-42 ${f.head} ${f.main}\n`);
    chmodSync(hook, 0o755);
    const result = f.run("review-init");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/identity changed|seed branch moved/);
    expect(f.git(f.canonical, "rev-parse", "refs/heads/temp/pr-42")).toBe(f.head);
    expect(f.git(f.worktree, "symbolic-ref", "HEAD")).toBe("refs/heads/temp/pr-42");
    expect(f.git(f.worktree, "write-tree")).toBe(
      f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
    );
  });

  it.each(["replaced", "deleted"] as const)(
    "retains native checkout evidence when a hook leaves the PR lock %s",
    (change) => {
      const f = coldFixture(false);
      f.git(f.canonical, "config", "--unset", "core.hooksPath");
      const lockRef = "refs/openclaw/pr-operation-locks/42";
      const receipt = join(f.root, "hook-lock-change.txt");
      const hook = join(f.canonical, ".git", "hooks", "post-checkout");
      const changeLock =
        change === "replaced"
          ? `replacement=$(printf 'successor-owned lock evidence\\n' | git hash-object -w --stdin) || exit 32
git update-ref --no-deref "${lockRef}" "$replacement" "$previous" || exit 33
printf '%s\\n' "$replacement" > "${receipt}"`
          : `git update-ref --no-deref -d "${lockRef}" "$previous" || exit 34
printf 'deleted\\n' > "${receipt}"`;
      writeFileSync(
        hook,
        `#!/bin/sh
previous=$(git rev-parse --verify "${lockRef}") || exit 31
printf 'hook-owned state after lock loss\\n' > src/subject.ts
${changeLock}
`,
      );
      chmodSync(hook, 0o755);

      const result = f.run("review-init");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("PR operation lock changed or is unreadable");
      expectSeed(f);
      expect(readFileSync(join(f.worktree, "src", "subject.ts"), "utf8")).toBe(
        "hook-owned state after lock loss\n",
      );
      expect(f.git(f.worktree, "write-tree")).toBe(
        f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
      );
      expect(f.git(f.canonical, "worktree", "list", "--porcelain")).toContain(f.worktree);
      expect(f.git(f.canonical, "status", "--porcelain")).toBe("");
      expect(existsSync(join(f.canonical, ".worktrees", ".templates"))).toBe(false);
      const observed = readFileSync(receipt, "utf8").trim();
      if (change === "replaced") {
        expect(observed).toMatch(/^[0-9a-f]{40}$/);
        expect(f.git(f.canonical, "rev-parse", "--verify", lockRef)).toBe(observed);
        expect(f.git(f.canonical, "cat-file", "blob", observed)).toBe(
          "successor-owned lock evidence",
        );
      } else {
        expect(observed).toBe("deleted");
        expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", lockRef)).toBe("");
      }
    },
  );

  // Only an actual accelerated host can prove this cell; a skip is not APFS proof.
  it.skipIf(process.platform !== "darwin")(
    "materializes full cold/warm PR siblings, then preserves native sparse transitions",
    () => {
      const f = coldFixture(false);
      const first = f.run("review-init");
      expect(first.status, first.stderr).toBe(0);
      const templates = join(f.canonical, ".worktrees", ".templates");
      expect(existsSync(templates)).toBe(true);
      const templateNames = readdirSync(templates).toSorted();
      expect(templateNames.length).toBeGreaterThan(0);
      expect(first.stderr).toContain("PR source checkout: filesystem template clone.");
      const template = listTemplates(f.env).find((entry) => entry.sourceCommit === f.main);
      expect(template?.backend).toBe("apfs");
      expect(template?.status).toBe("ready");
      const warmResult = nextPr(f, 43);
      expect(warmResult.stderr).toContain("PR source checkout: filesystem template clone.");
      const warm = warmResult.worktree;
      expect(readdirSync(templates).toSorted()).toEqual(templateNames);
      expectSeed(f, 43);
      const firstIndex = f.git(
        f.worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      );
      const warmIndex = f.git(warm, "rev-parse", "--path-format=absolute", "--git-path", "index");
      expect(warmIndex).not.toBe(firstIndex);
      writeFileSync(join(f.worktree, "src", "subject.ts"), "first sibling edit\n");
      expect(readFileSync(join(warm, "src", "subject.ts"), "utf8")).toBe(
        "export const subject = 'base';\n",
      );
      writeFileSync(join(warm, "src", "subject.ts"), "warm sibling edit\n");

      // Original order: full cold/warm, sparse sibling, full sibling while sparse,
      // native disable, then another full sibling. Never reset common config.
      const sparse = nextPr(f, 44).worktree;
      f.git(sparse, "sparse-checkout", "set", "--cone", "src");
      const origins = f.git(sparse, "config", "--show-origin", "--show-scope", "--list");
      expect(origins).toContain("extensions.worktreeconfig=true");
      expect(f.git(sparse, "config", "--bool", "core.sparseCheckout")).toBe("true");
      const whileSparseResult = nextPr(f, 45);
      expect(whileSparseResult.stderr).toContain("PR source checkout: Git checkout.");
      const whileSparse = whileSparseResult.worktree;
      expect(existsSync(join(whileSparse, "scripts", "pr"))).toBe(true);
      expect(f.git(sparse, "config", "--bool", "core.sparseCheckout")).toBe("true");
      f.git(sparse, "sparse-checkout", "disable");
      const afterDisableResult = nextPr(f, 46);
      expect(afterDisableResult.stderr).toContain("PR source checkout: Git checkout.");
      const afterDisable = afterDisableResult.worktree;
      expect(existsSync(join(afterDisable, "scripts", "pr"))).toBe(true);
      const laterSparseResult = nextPr(f, 47);
      expect(laterSparseResult.stderr).toContain("PR source checkout: Git checkout.");
      f.git(laterSparseResult.worktree, "sparse-checkout", "set", "--cone", "src");
      expect(f.git(laterSparseResult.worktree, "config", "--bool", "core.sparseCheckout")).toBe(
        "true",
      );
      expect(f.git(sparse, "config", "--bool", "core.sparseCheckout")).toBe("false");
      expect(
        f.git(
          laterSparseResult.worktree,
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index",
        ),
      ).not.toBe(f.git(sparse, "rev-parse", "--path-format=absolute", "--git-path", "index"));
      expect(readdirSync(templates).toSorted()).toEqual(templateNames);
      expect(f.git(f.canonical, "config", "--bool", "extensions.worktreeConfig")).toBe("true");
      expect(readFileSync(join(f.worktree, "src", "subject.ts"), "utf8")).toBe(
        "first sibling edit\n",
      );
      expect(readFileSync(join(warm, "src", "subject.ts"), "utf8")).toBe("warm sibling edit\n");
      expect(readFileSync(join(template!.path, "src", "subject.ts"), "utf8")).toBe(
        "export const subject = 'base';\n",
      );
      for (const pr of [43, 44, 45, 46, 47]) {
        expectSeed(f, pr);
      }
    },
  );
});
