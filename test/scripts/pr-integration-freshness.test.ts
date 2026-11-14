import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, delimiter, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expandTsgoExecutionGraphs,
  TSGO_CI_GRAPHS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const root = process.cwd();
const describePosix = process.platform === "win32" ? describe.skip : describe;
function fixture() {
  const repo = dirs.make("pr-integration-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
    }).trim();
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const admit = (main: string, head: string, localOnly = "false") =>
    spawnSync(
      "bash",
      [
        "-c",
        'script_parent_dir="$1/scripts"; source "$script_parent_dir/pr-lib/merge.sh"; pr_git() { command git "$@"; }; verify_merge_candidate_tree "$2" "$3" "$4"',
        "fixture",
        root,
        main,
        head,
        localOnly,
      ],
      { cwd: repo, env, encoding: "utf8", timeout: 90_000 },
    );
  git("init", "-q", "-b", "main");
  put(".gitignore", "node_modules/\n.local/\n");
  put("src/retention.ts", "export const forceFullGc = () => true;\n");
  return { repo, env, git, put, commit, admit };
}

describePosix("current-main compiler integration admission", () => {
  it("rejects disjoint export-removal/new-consumer interaction through the existing compiler planner", () => {
    const f = fixture();
    // Only compiler dependencies; offline preparation never downloads or executes lifecycle scripts.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    f.put(
      "package.json",
      JSON.stringify({
        private: true,
        type: "module",
        devDependencies: {
          tsrs: pkg.devDependencies.tsrs,
          typescript: pkg.devDependencies.typescript,
        },
      }),
    );
    f.put("pnpm-workspace.yaml", "packages: []\n");
    f.put("smoke.ts", "export {};\n");
    for (const graph of [
      ...expandTsgoExecutionGraphs(TSGO_CI_GRAPHS),
      { name: "canonical", config: "test/tsconfig/tsconfig.core.test.json" },
    ]) {
      const source = graph.name === "core" ? "src/**/*.ts" : "smoke.ts";
      f.put(
        graph.config,
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            noEmit: true,
            strict: true,
            types: [],
            tsBuildInfoFile: graph.name + ".tsbuildinfo",
          },
          include: [relative(dirname(graph.config), source)],
        }),
      );
    }
    // Installation is not the invariant under test. Supply physical copies of
    // the installed native compilers while keeping the planner and compiler real.
    const require = createRequire(join(root, "package.json"));
    const packages: Record<string, string> = {};
    for (const name of ["tsrs", "typescript"]) {
      const source = dirname(require.resolve(name + "/package.json"));
      packages[name] = source;
      const compilerPackage = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
        optionalDependencies: Record<string, string>;
      };
      const ownRequire = createRequire(join(source, "package.json"));
      for (const dependency of Object.keys(compilerPackage.optionalDependencies)) {
        try {
          packages[dependency] = dirname(ownRequire.resolve(dependency + "/package.json"));
        } catch {
          /* Other platforms are not installed. */
        }
      }
    }
    const bin = dirs.make("pr-integration-bin-");
    writeFileSync(
      join(bin, "pnpm"),
      "#!" +
        process.execPath +
        "\n" +
        "const fs=require('node:fs'),p=require('node:path');\n" +
        "for(const [name,source] of Object.entries(" +
        JSON.stringify(packages) +
        ")){const target=p.join(process.cwd(),'node_modules',name);fs.mkdirSync(p.dirname(target),{recursive:true});fs.cpSync(source,target,{recursive:true,dereference:true});}\n",
      { mode: 0o755 },
    );
    f.env.PATH = bin + delimiter + f.env.PATH;
    const base = f.commit();
    const compile = () =>
      spawnSync(
        process.execPath,
        [
          join(root, "scripts/run-tsgo.mjs"),
          "-p",
          join(f.repo, "tsconfig.core.json"),
          "--pretty",
          "false",
        ],
        { cwd: root, env: f.env, encoding: "utf8", timeout: 30_000 },
      );
    f.put("src/retention.ts", "export {};\n");
    const main = f.commit();
    expect(compile().status).toBe(0);
    f.git("checkout", "-q", "--detach", base);
    f.put(
      "src/consumer.ts",
      "import { forceFullGc } from './retention.js';\nexport const collected = forceFullGc();\n",
    );
    const head = f.commit();
    expect(compile().status).toBe(0);
    const tree = f.git("merge-tree", "--write-tree", main, head);
    const rejected = f.admit(main, head);
    expect(rejected.status, rejected.stdout + rejected.stderr).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain("TS2305");
    expect(rejected.stdout).toContain("main=" + main + " head=" + head + " tree=" + tree);
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    expect(f.git("status", "--porcelain")).toBe("");
    // Removing the retired import makes the composition valid; drift alone does not refuse it.
    f.put("src/consumer.ts", "export const collected = true;\n");
    const repaired = f.commit();
    const accepted = f.admit(main, repaired);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("Integration static proof passed");
  }, 90_000);

  it("keeps no-drift/noncompiler fast paths and refuses unsupported or late compiler proof", () => {
    const f = fixture();
    const base = f.commit();
    f.put("src/consumer.ts", "export {};\n");
    const head = f.commit();
    expect(f.admit(base, head).status).toBe(0);
    f.git("checkout", "-q", "--detach", base);
    f.put("notes.md", "unrelated\n");
    const docs = f.commit();
    expect(f.admit(docs, head).status).toBe(0);
    expect(f.admit(head, docs).status).toBe(0);
    expect(existsSync(join(f.repo, ".local"))).toBe(false);
    f.put("src/global.d.ts", "declare const ambient: boolean;\n");
    const ambient = f.commit();
    const unsupported = f.admit(ambient, head);
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain("requires full fallback");
    const late = f.admit(ambient, head, "true");
    expect(late.status).toBe(1);
    expect(late.stderr).toContain("during final authority verification");
  });
});
