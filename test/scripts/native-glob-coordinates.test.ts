import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { convertPathToPattern } from "tinyglobby";
import { afterEach, expect, it } from "vitest";
import { resolveTestRuntime } from "../../scripts/lib/test-runtime.mts";
import { resolveVitestSpawnParams, spawnWatchedVitestProcess } from "../../scripts/run-vitest.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const slash = (value: string) => value.split(path.sep).join("/");

function write(directory: string, file: string, content = "") {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

async function globModule(format: string): Promise<typeof import("tinyglobby")> {
  const entry = fs.realpathSync(require.resolve("tinyglobby"));
  return format === "cjs"
    ? require(entry)
    : import(pathToFileURL(path.join(path.dirname(entry), "index.mjs")).href);
}

it.each(["cjs", "esm"])("preserves native discovery coordinates in %s", async (format) => {
  const directory = tempDirs.make("native-glob-");
  const cwd = path.join(directory, "pkg/dist");
  const files = [
    "pkg/root.mjs",
    "pkg/sibling/peer.mjs",
    "pkg/ignored/outside.mjs",
    "pkg/dist/index.mjs",
    "pkg/dist/.hidden.mjs",
    "pkg/dist/nested/deep.mjs",
    "pkg/dist/ignored/inside.mjs",
    "other/outside.mjs",
  ];
  for (const file of files) {
    write(directory, file);
  }
  const absolute = (pattern: string) => `${convertPathToPattern(directory)}/${pattern}`;
  const all = [
    "../root.mjs",
    "../sibling/peer.mjs",
    "../ignored/outside.mjs",
    "index.mjs",
    ".hidden.mjs",
    "nested/deep.mjs",
    "ignored/inside.mjs",
  ];
  const cases = [
    { include: [absolute("pkg/**/*.mjs")], ignore: [], expected: all },
    {
      include: [absolute("pkg/**/*.mjs"), "index.mjs"],
      ignore: [absolute("pkg/ignored/**"), "ignored/**"],
      expected: [
        "../root.mjs",
        "../sibling/peer.mjs",
        "index.mjs",
        ".hidden.mjs",
        "nested/deep.mjs",
      ],
    },
    {
      include: [absolute("pkg/dist/nested/**/*.mjs")],
      ignore: [],
      expected: ["nested/deep.mjs"],
    },
    {
      include: ["**/*.mjs", `!${absolute("pkg/dist/ignored/**")}`],
      ignore: [],
      expected: ["index.mjs", ".hidden.mjs", "nested/deep.mjs"],
    },
    {
      include: [absolute("pkg/**/*.mjs")],
      ignore: [absolute("pkg/**")],
      expected: [],
    },
  ];
  const globby = await globModule(format);
  for (const scenario of cases) {
    for (const absoluteOutput of [false, true]) {
      const options = {
        cwd,
        dot: true,
        expandDirectories: false,
        ignore: scenario.ignore,
        absolute: absoluteOutput,
      };
      const expected = scenario.expected
        .map((file) => (absoluteOutput ? slash(path.resolve(cwd, file)) : file))
        .toSorted();
      expect(globby.globSync(scenario.include, options).toSorted()).toEqual(expected);
      expect((await globby.glob(scenario.include, options)).toSorted()).toEqual(expected);
    }
  }
});

it.skipIf(process.platform === "win32").each(["cjs", "esm"])(
  "keeps POSIX backslashes literal in %s matching and exclusions",
  async (format) => {
    const cwd = tempDirs.make("native-glob-literal-");
    const literal = write(cwd, "a\\b.test.ts");
    const globby = await globModule(format);
    for (const absolute of [false, true]) {
      const options = { cwd, absolute, expandDirectories: false };
      const expected = [absolute ? literal : "a\\b.test.ts"];
      const include = convertPathToPattern(literal);
      expect(globby.globSync(include, options)).toEqual(expected);
      expect(await globby.glob(include, options)).toEqual(expected);
      expect(globby.globSync("*.test.ts", { ...options, ignore: [include] })).toEqual([]);
      expect(await globby.glob("*.test.ts", { ...options, ignore: [include] })).toEqual([]);
    }
  },
);

it("preserves Windows drive and filename case in native test admission", async ({ signal }) => {
  const directory = tempDirs.make("native-glob-admission-");
  const runtime = resolveTestRuntime(process.env);
  fs.symlinkSync(
    fs.realpathSync(path.join(root, "node_modules")),
    path.join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const probe = write(
    directory,
    "admission.mjs",
    `
    import assert from 'node:assert/strict';
    import {createVitest} from 'vitest/node';
    assert.equal(Boolean(process.versions.bun),${runtime === "bun"});
    for(const drive of ['c:','C:']){
      const prefix=drive+'/fixture';
      const ctx=await createVitest({
        root:${JSON.stringify(directory)},config:false,watch:false,run:true,reporters:[],
        include:[],includeSource:[],
      });
      try{
        const project=ctx.getRootProject();
        assert.deepEqual((await project.globTestFiles()).testFiles,[]);
        project.config.include=[prefix+'/**/*.test.ts','**/*.relative.ts'];
        project.config.exclude=[prefix+'/**/blocked.*'];
        project.config.includeSource=[prefix+'/**/*.source.ts'];
        let reads=0;
        const source=()=>{reads++;return 'if (import.meta.vitest) {}';};
        assert.equal(project.matchesTestGlob(prefix+'/new.test.ts',source),true,drive+' uncached absolute include');
        assert.equal(project.matchesTestGlob((prefix+'/backslash.test.ts').replaceAll('/','\\\\'),source),true);
        assert.equal(project.matchesTestGlob(prefix+'/blocked.relative.ts',source),false);
        assert.equal(project.matchesTestGlob(project.config.root+'/ordinary.relative.ts',source),true);
        assert.equal(project.matchesTestGlob(prefix+'/wrong.TEST.ts',source),false);
        assert.equal(project.matchesTestGlob(prefix+'/blocked.source.ts',source),false);
        assert.equal(project.matchesTestGlob(prefix+'/unrelated.ts',source),false);
        assert.equal(reads,0);
        assert.equal(project.matchesTestGlob(prefix+'/live.source.ts',source),true);
        assert.equal(reads,1);
        assert.equal(project.matchesTestGlob(prefix+'/plain.source.ts',()=>{reads++;return 'export {};';}),false);
        assert.equal(reads,2);
        project.config.exclude.push(prefix+'/**');
        assert.equal(project.matchesTestGlob(prefix+'/new.test.ts',source),true);
        assert.equal(reads,2);
      }finally{await ctx.close();}
    }
    `,
  );
  const result = await runNodeScript(probe, testRunnerFixtureEnv(), 20_000, {
    cwd: directory,
    executable: process.execPath,
    signal,
    requireProcessTreeExit: process.platform !== "win32",
    maxBuffer: 128 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
});

type WatchRecord = {
  kind: "module" | "ready" | "add" | "removed" | "run";
  file?: string;
  owner?: string;
  state?: string;
  tests?: Array<{ name: string; state: string }>;
  cached?: string[];
  owners?: string[];
  errors?: number;
};

// This fixture requires the native POSIX process-group join contract.
it.skipIf(process.platform === "win32").for([".", "test/scripts"])(
  "discovers new files with native owner scopes and discovery dir %s",
  { timeout: 120_000 },
  async (discoveryDir, { onTestFinished, signal }) => {
    const lifetime = createFixtureLifetime();
    onTestFinished(() => lifetime.cleanup());
    await lifetime.run(async () => {
      const artifacts = path.join(root, ".artifacts");
      fs.mkdirSync(artifacts, { recursive: true });
      const directory = lifetime.createTempDir("native-watch-", artifacts);
      const receipt = await lifetime.acquire(async () => {
        const channel = await openFixtureReceiptChannel();
        return { ...channel, cleanup: () => channel.close() };
      });
      const observed = path.join(directory, "observed.jsonl");
      const seed = "test/scripts/native-glob-seed.test.ts";
      const runtime = resolveTestRuntime(process.env);
      expect(Boolean(process.versions.bun)).toBe(runtime === "bun");
      const source = (generation: number, inSource = false) => {
        const body = `it('generation ${generation}',()=>{
          expect(Boolean(process.versions.bun)).toBe(${runtime === "bun"});
          expect(${generation}).toBeGreaterThan(0);
        });`;
        return inSource
          ? `if(import.meta.vitest){const {it,expect}=import.meta.vitest;${body}}`
          : `import {it,expect} from 'vitest';${body}`;
      };
      write(directory, seed, source(1));
      write(
        directory,
        "test/scripts/blocked/initial.test.ts",
        "throw new Error('excluded fixture');",
      );
      const reporter = write(
        directory,
        "reporter.mjs",
        `
        import fs from 'node:fs';
        import path from 'node:path';
        ${fixtureReceiptClientSource(receipt.endpoint)}
        const observed=${JSON.stringify(observed)},root=${JSON.stringify(directory)};
        const relative=(file)=>path.relative(root,file).split(path.sep).join('/');
        function record(value,token){
          fs.appendFileSync(observed,JSON.stringify(value)+'\\n');
          sendReceipt(observed,token);
        }
        export default class {
          onInit(ctx){this.ctx=ctx;}
          onTestModuleEnd(module){
            const tests=[...module.children.allTests()].map(test=>({name:test.name,state:test.result().state}));
            const file=relative(module.moduleId);
            (this.completed??=[]).push(file+':'+tests.map(test=>test.name).join(','));
            record({kind:'module',file,owner:module.project.name,state:module.state(),tests},
              'module:'+file+':'+tests.map(test=>test.name).join(','));
          }
          onTestRunEnd(_modules,errors){record({kind:'run',errors:errors.length},'run');}
          onTestRemoved(file){record({kind:'removed',file:relative(file)},'removed:'+relative(file));}
          onWatcherStart(){
            if(!this.observing){
              this.observing=true;
              this.ctx.vite.watcher.on('add',file=>{
                const normalized=file.split(path.sep).join('/');
                record({kind:'add',file:relative(file),
                  owners:this.ctx.projects.filter(project=>project._isCachedTestFile(normalized)).map(project=>project.name)},
                  'add:'+relative(file));
              });
            }
            record({kind:'ready',
              cached:this.ctx.projects.filter(project=>project._isCachedTestFile(${JSON.stringify(slash(path.join(directory, seed)))})).map(project=>project.name)},'ready');
            for(const completed of this.completed??[])sendReceipt(observed,'ready:'+completed);
            this.completed=[];
          }
        }
      `,
      );
      const config = write(
        directory,
        "vitest.config.mts",
        `
        import path from 'node:path';
        import {convertPathToPattern} from 'tinyglobby';
        import {createToolingVitestConfig} from ${JSON.stringify(pathToFileURL(path.join(root, "test/vitest/vitest.tooling.config.ts")).href)};
        import {createToolingIsolatedVitestConfig} from ${JSON.stringify(pathToFileURL(path.join(root, "test/vitest/vitest.tooling-isolated.config.ts")).href)};
        import {createToolingDockerVitestConfig} from ${JSON.stringify(pathToFileURL(path.join(root, "test/vitest/vitest.tooling-docker.config.ts")).href)};
        const root=${JSON.stringify(directory)},repo=${JSON.stringify(root)};
        const anchor=pattern=>path.isAbsolute(pattern)
          ? convertPathToPattern(root)+'/'+path.relative(repo,pattern).split(path.sep).join('/')
          : convertPathToPattern(root)+'/'+pattern;
        const projects=[createToolingVitestConfig({}),createToolingIsolatedVitestConfig({}),createToolingDockerVitestConfig({})].map(config=>({
          extends:false,root,test:{
            name:config.test.name,dir:path.resolve(root,${JSON.stringify(discoveryDir)}),
            include:config.test.include.map(anchor),
            exclude:[...config.test.exclude.map(anchor),'**/blocked/**',anchor('test/scripts/no-run.test.ts'),anchor('src/ignored.source.ts')],
            includeSource:config.test.name==='tooling'?[anchor('**/*.source.ts')]:[],
            environment:'node',pool:'forks',maxWorkers:1,isolate:true,setupFiles:[],
          }
        }));
        export default {root,server:{watch:{usePolling:true}},test:{
          projects,reporters:[${JSON.stringify(reporter)}],maxWorkers:1,fileParallelism:false
        }};
      `,
      );
      const env = testRunnerFixtureEnv({ OPENCLAW_VITEST_RUNTIME: runtime });
      const handle = spawnWatchedVitestProcess({
        pnpmArgs: [
          "exec",
          "node",
          "node_modules/vitest/vitest.mjs",
          "--watch",
          "--config",
          config,
          "--configLoader",
          "runner",
        ],
        spawnParams: resolveVitestSpawnParams(env),
        env,
      });
      const wait = (token: string) =>
        withinTest(
          awaitGateBeforeSettlement(
            receipt.waitFor(observed, token),
            handle.completion,
            `watch exited before ${token}`,
          ),
          signal,
        );
      const records = (): WatchRecord[] =>
        fs
          .readFileSync(observed, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      try {
        await Promise.all([wait(`module:${seed}:generation 1`), wait("ready")]);
        const initial = records().filter((record) => record.kind === "module");
        expect(initial.map((record) => [record.file, record.owner])).toEqual([[seed, "tooling"]]);
        const negatives = [
          "test/scripts/blocked/later.test.ts",
          "test/scripts/no-run.test.ts",
          "src/ignored.source.ts",
          "src/not-a-test.source.ts",
        ];
        const excluded = negatives.map((file) => wait(`add:${file}`));
        for (const file of negatives) {
          write(
            directory,
            file,
            file.endsWith("not-a-test.source.ts")
              ? "throw new Error('not an in-source test');"
              : "throw new Error('excluded fixture'); // import.meta.vitest",
          );
        }
        await Promise.all(excluded);
        for (const file of negatives) {
          expect(
            records().find((record) => record.kind === "add" && record.file === file)?.owners,
          ).toEqual([]);
        }
        const additions = [
          ["test/scripts/upgrade-survivor-native-systemd.test.ts", "tooling"],
          ["test/scripts/vitest-fork-shutdown.test.ts", "tooling-isolated"],
          ["test/scripts/docker-build-helper.test.ts", "tooling-docker"],
          ["src/live.source.ts", "tooling"],
        ] as const;
        const created = additions.map(([file]) => wait(`module:${file}:generation 1`));
        for (const [file] of additions) {
          write(directory, file, source(1, file.endsWith(".source.ts")));
        }
        await Promise.all(created);
        const edited = wait(`module:${seed}:generation 2`);
        write(directory, seed, source(2));
        await edited;
        const recreate = additions[1][0];
        const removed = wait(`removed:${recreate}`);
        fs.unlinkSync(path.join(directory, recreate));
        await removed;
        const recreated = wait(`module:${recreate}:generation 2`);
        write(directory, recreate, source(2));
        await recreated;
        await wait(`ready:${recreate}:generation 2`);
        const final = records();
        const modules = final.filter((record) => record.kind === "module");
        expect(modules).toHaveLength(7);
        for (const [file, owner] of [[seed, "tooling"], ...additions]) {
          const expectedCount = file === seed || file === recreate ? 2 : 1;
          const matches = modules.filter((record) => record.file === file);
          expect(matches).toHaveLength(expectedCount);
          for (const record of matches) {
            expect(record.owner).toBe(owner);
            expect(record.state).toBe("passed");
            expect(record.tests).toHaveLength(1);
            expect(record.tests?.[0]?.state).toBe("passed");
          }
        }
        expect(
          final.filter((record) => record.kind === "run").every((record) => record.errors === 0),
        ).toBe(true);
        expect(
          final
            .filter((record) => record.kind === "ready")
            .every((record) => record.cached?.join(",") === "tooling"),
        ).toBe(true);
      } finally {
        handle.child.kill("SIGTERM");
        await lifetime.verifyCleanup(async () => {
          const result = await handle.completion;
          expect(result.groupJoined).toBe(true);
          expect(handle.child.stdout?.closed).toBe(true);
          expect(handle.child.stderr?.closed).toBe(true);
        });
        await receipt.cleanup();
      }
    });
  },
);
