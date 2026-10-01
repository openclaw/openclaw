import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as privateWorkspaceRemoval from "../../infra/fs-safe-remove.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createNodeEvalArgs, resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { runFreshUpdateArtifact } from "./update-command-artifact.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { UpdateCommandFailure } from "./update-command-result.js";

let childCleanupUncertain = false;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    if (childCleanupUncertain) {
      throw new Error("Artifact fixture child cleanup is uncertain; retaining its inputs");
    }
    cleanup();
  }),
);
beforeEach(() => {
  if (childCleanupUncertain) {
    throw new Error("Artifact fixture child cleanup is uncertain; refusing further work");
  }
});
const childUrl = (key: keyof typeof updateExecutorNativeEntrypoints) =>
  resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints[key]).href;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  "activate",
  "refuse",
  "directory",
  "activation-refusal",
  "uncertain",
  "replace-workspace",
] as const)(
  "isolates real npm lifecycle state until artifact %s",
  async (action) => {
    const base = dirs.make("fresh-artifact-lifecycle-");
    const home = path.join(base, "home");
    const canonicalState = path.join(home, "state");
    const canonicalConfig = path.join(canonicalState, "openclaw.json");
    const canonicalTmp = path.join(base, "inherited-tmp");
    const control = path.join(base, "control");
    await fs.mkdir(canonicalState, { recursive: true });
    await fs.mkdir(canonicalTmp);
    await fs.mkdir(control, { mode: 0o700 });
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    await fs.writeFile(canonicalConfig, "{}\n");
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", canonicalState);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", canonicalConfig);
    vi.stubEnv("STATE_DIRECTORY", canonicalState);
    vi.stubEnv("NODE_COMPILE_CACHE", canonicalTmp);
    vi.stubEnv("OPENCLAW_AGENT_DIR", canonicalState);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", path.join(canonicalState, "continuation"));
    const target = createNpmTarget(path.join(base, "prefix", "lib", "node_modules"));
    target.npmOwner = { version: "11.10.0", lifecyclePolicy: "unflagged" };
    const root = target.packageRoot!;
    await writePackageRoot(root, "1.0.0");
    const source = path.join(base, "package");
    await writePackageRoot(source, "1.0.1");
    await fs.writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "1.0.1",
        type: "module",
        bin: { openclaw: "dist/index.js" },
        openclaw: { schemaVersions: { state: 17, agent: 19 } },
        scripts: { postinstall: "node lifecycle.cjs" },
      }),
    );
    await fs.writeFile(
      path.join(source, "lifecycle.cjs"),
      `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
      fs.mkdirSync(process.env.OPENCLAW_STATE_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.OPENCLAW_STATE_DIR,'lifecycle'),'private');
      fs.writeFileSync(path.join(os.tmpdir(),'lifecycle'),'private');
      fs.writeFileSync('lifecycle-paths.json',JSON.stringify({home:process.env.HOME,openclawHome:process.env.OPENCLAW_HOME,state:process.env.OPENCLAW_STATE_DIR,tmp:os.tmpdir()}));
      for(const key of ['STATE_DIRECTORY','OPENCLAW_AGENT_DIR','NODE_COMPILE_CACHE']) {
        if(process.env[key]) fs.writeFileSync(path.join(process.env[key],'leaked'),'bad');
      }
      if(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH) fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH,'bad');
    `,
    );
    await fs.writeFile(
      path.join(source, "dist", "index.js"),
      `#!/usr/bin/env node
      import fs from 'node:fs';
      if(process.argv.includes('doctor')) fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({doctorState:process.env.OPENCLAW_STATE_DIR}));
    `,
    );
    await fs.chmod(path.join(source, "dist", "index.js"), 0o755);
    await writePackageDistInventory(source);
    const archive = path.join(base, "candidate.tgz");
    execFileSync("tar", ["-czf", archive, "-C", base, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const artifactSpec = action === "directory" ? `file:${source}` : archive;
    const params = {
      root,
      installKind: "package" as const,
      tag: artifactSpec,
      installSpec: artifactSpec,
      timeoutMs: 30_000,
      startedAt: Date.now(),
      progress: {},
      installTarget: target,
      nodeRunner: path.join(base, "not-the-selected-node"),
      installEnv: {
        ...process.env,
        npm_config_userconfig: path.join(base, "empty-user.npmrc"),
        npm_config_globalconfig: path.join(base, "empty-global.npmrc"),
        npm_config_cache: path.join(base, "npm-cache"),
      },
      managedServiceEnv: {
        HOME: home,
        OPENCLAW_STATE_DIR: canonicalState,
        OPENCLAW_CONFIG_PATH: canonicalConfig,
      },
    };
    if (action === "uncertain") {
      const receipt = path.join(base, "uncertain-child.json");
      const childScript = `import assert from 'node:assert/strict';
          import fs from 'node:fs';
          import path from 'node:path';
          import JSON5 from 'json5';
          import {resolveSecureTempRoot} from '@openclaw/fs-safe/temp';
          import {registerSealedRuntime} from ${JSON.stringify(childUrl("sealedRuntime"))};
          import {CommandProcessCleanupError,hasCommandProcessCleanupError} from ${JSON.stringify(childUrl("commandCleanup"))};
          registerSealedRuntime({json5:JSON5,resolveSecureTempRoot:options=>resolveSecureTempRoot({...options,preferredDir:${JSON.stringify(control)},tmpdir:()=>${JSON.stringify(control)}})});
          const {runFreshUpdateArtifact}=await import(${JSON.stringify(childUrl("artifact"))});
          const params=${JSON.stringify({ ...params, installEnv: undefined, managedServiceEnv: undefined })};
          params.installEnv={...process.env,NODE_COMPILE_CACHE:${JSON.stringify(canonicalTmp)},npm_config_userconfig:${JSON.stringify(path.join(base, "empty-user.npmrc"))},npm_config_globalconfig:${JSON.stringify(path.join(base, "empty-global.npmrc"))},npm_config_cache:${JSON.stringify(path.join(base, "npm-cache"))}};
          params.managedServiceEnv=${JSON.stringify(params.managedServiceEnv)};
          const initialization={target:{currentVersion:'1.0.0',targetVersion:null,downgradeRisk:false,packageAlreadyCurrent:false,refuseUpdate:async()=>{throw new Error('Unexpected metadata refusal');}}};
          let observed;
          try {
            await runFreshUpdateArtifact({initialization,stageParams:()=>params,json:true},async()=>{
              const stage=initialization.stagedPackage;
              const paths=JSON.parse(fs.readFileSync(path.join(stage.root,'lifecycle-paths.json'),'utf8'));
              const identity=fs.statSync(paths.openclawHome,{bigint:true});
              observed={paths,stageRoot:stage.root,dev:String(identity.dev),ino:String(identity.ino)};
              try {
                await stage.run({...params,nodeRunner:process.execPath,validateCandidate:async()=>[],beforeActivate:async()=>{throw new CommandProcessCleanupError();},onTransaction:()=>{throw new Error('Unexpected publication');}});
              } catch(error) { throw new Error('fixture reported uncertainty',{cause:error}); }
            });
            throw new Error('Expected canonical cleanup uncertainty');
          } catch(error) { assert(hasCommandProcessCleanupError(error)); }
          assert(observed);
          observed.retainedBeforeExit=fs.existsSync(observed.paths.openclawHome);
          fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(observed));
          process.exit(0);`;
      try {
        const child = await runCommandWithTimeout(
          [resolveTestNodeExecPath(), ...createNodeEvalArgs(childScript, { imports: ["tsx"] })],
          {
            timeoutMs: 30_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            env: { NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: "1" },
          },
        );
        childCleanupUncertain = child.cleanup === "uncertain";
        expect(child, child.stderr).toMatchObject({ code: 0, termination: "exit" });
      } catch (error) {
        childCleanupUncertain ||= hasCommandProcessCleanupError(error);
        throw error;
      }
      const observed = JSON.parse(await fs.readFile(receipt, "utf8"));
      expect(observed.retainedBeforeExit).toBe(true);
      expect(await fs.stat(observed.paths.openclawHome, { bigint: true })).toMatchObject({
        dev: BigInt(observed.dev),
        ino: BigInt(observed.ino),
      });
      for (const directory of [observed.paths.state, observed.paths.tmp]) {
        expect(await fs.readFile(path.join(directory, "lifecycle"), "utf8")).toBe("private");
      }
      expect((await fs.stat(observed.stageRoot)).isDirectory()).toBe(true);
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version).toBe(
        "1.0.0",
      );
      expect(await fs.readFile(canonicalConfig, "utf8")).toBe("{}\n");
      expect(await fs.readdir(canonicalTmp)).toEqual([]);
      return;
    }
    let isolatedHome: string | undefined;
    const initialization: Parameters<typeof runFreshUpdateArtifact>[0]["initialization"] = {
      target: {
        currentVersion: "1.0.0",
        targetVersion: null,
        packageTargetSchemaVersions: undefined,
        packageRuntimeTarget: undefined,
        downgradeRisk: false,
        packageAlreadyCurrent: false,
        refuseUpdate: async (_reason, message) => {
          throw new Error(message);
        },
      },
    };
    const refusal = new Error("fixture publication refused");
    const reported = new UpdateCommandFailure(
      {
        status: "error",
        mode: "npm",
        root,
        reason: "runtime-artifact-publication",
        durationMs: 0,
        steps: [],
      },
      1,
      refusal.message,
      { cause: refusal },
    );
    const outcome = runFreshUpdateArtifact(
      { initialization, stageParams: () => params, json: true },
      async () => {
        const stage = initialization.stagedPackage;
        assert(stage);
        const paths = JSON.parse(
          await fs.readFile(path.join(stage.root, "lifecycle-paths.json"), "utf8"),
        );
        isolatedHome = paths.openclawHome;
        expect(paths.home).toBe(home);
        expect(paths.state).not.toBe(canonicalState);
        expect(await fs.readFile(path.join(paths.state, "lifecycle"), "utf8")).toBe("private");
        expect(await fs.readFile(path.join(paths.tmp, "lifecycle"), "utf8")).toBe("private");
        expect(initialization.target.targetVersion).toBe("1.0.1");
        expect(await fs.readdir(canonicalState)).toEqual(["openclaw.json"]);
        expect(await fs.readdir(canonicalTmp)).toEqual([]);
        expect(await fs.readFile(canonicalConfig, "utf8")).toBe("{}\n");
        if (action === "replace-workspace") {
          await fs.rename(paths.openclawHome, `${paths.openclawHome}.displaced`);
          await fs.mkdir(paths.openclawHome, { mode: 0o700 });
          await fs.writeFile(path.join(paths.openclawHome, "replacement"), "must remain");
          return;
        }
        if (action === "refuse") {
          return;
        }
        let transaction: PackageUpdateTransaction | undefined;
        const running = stage.run({
          ...params,
          nodeRunner: process.execPath,
          validateCandidate: async (candidate) => {
            expect(candidate).toBe(stage.root);
            return [];
          },
          beforeActivate: async () => {
            if (action === "activation-refusal") {
              throw refusal;
            }
          },
          onTransaction: (value) => {
            transaction = value;
          },
        });
        if (action === "activation-refusal") {
          await expect(running).rejects.toBe(refusal);
          throw reported;
        }
        const result = await running;
        expect(result.status).toBe("ok");
        expect(JSON.parse(await fs.readFile(canonicalConfig, "utf8"))).toEqual({
          doctorState: canonicalState,
        });
        expect(transaction).toBeDefined();
        await transaction!.complete({ activationVerified: true }, () => undefined);
      },
    );
    if (action === "replace-workspace") {
      await expect(outcome).rejects.toMatchObject({ code: "path-mismatch" });
      assert(isolatedHome);
      expect(await fs.readFile(path.join(isolatedHome, "replacement"), "utf8")).toBe("must remain");
      expect(
        await fs.readFile(path.join(`${isolatedHome}.displaced`, "state", "lifecycle"), "utf8"),
      ).toBe("private");
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version).toBe(
        "1.0.0",
      );
      return;
    } else if (action === "activation-refusal") {
      await expect(outcome).rejects.toBe(reported);
    } else {
      await outcome;
    }
    const activated = action === "activate" || action === "directory";
    expect(await fs.readdir(canonicalTmp)).toEqual([]);
    expect((await fs.readdir(canonicalState)).toSorted()).toEqual(
      activated ? ["openclaw.json", "openclaw.json.pre-update"] : ["openclaw.json"],
    );
    expect(isolatedHome).toBeDefined();
    await expect(fs.stat(isolatedHome!)).rejects.toMatchObject({ code: "ENOENT" });
    if (!activated) {
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version).toBe(
        "1.0.0",
      );
    }
  },
  60_000,
);

it("preserves an artifact refusal when private workspace cleanup also fails", async () => {
  await withTestDir({ prefix: "artifact-cleanup-refusal-" }, async (base) => {
    const control = path.join(base, "control");
    await fs.mkdir(control, { mode: 0o700 });
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const root = path.join(base, "candidate");
    await writePackageRoot(root, "1.0.1");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "1.0.1",
        openclaw: { schemaVersions: { state: 17, agent: 19 } },
      }),
    );
    const stage = { root, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(packageUpdate, "stagePackageInstallUpdate").mockResolvedValue(stage);
    const primary = new Error("fixture original artifact refusal");
    const cleanupFailure = new Error("fixture private workspace cleanup failed");
    const removeWorkspace = privateWorkspaceRemoval.removePathWithinRoot;
    const cleanup = vi.fn();
    vi.spyOn(privateWorkspaceRemoval, "removePathWithinRoot").mockImplementation(
      async (options) => {
        await removeWorkspace(options);
        cleanup();
        throw cleanupFailure;
      },
    );
    const initialization: Parameters<typeof runFreshUpdateArtifact>[0]["initialization"] = {
      target: {
        currentVersion: "1.0.0",
        targetVersion: null,
        packageTargetSchemaVersions: undefined,
        packageRuntimeTarget: undefined,
        downgradeRisk: false,
        packageAlreadyCurrent: false,
        refuseUpdate: async () => {
          throw primary;
        },
      },
    };
    const outcome = await runFreshUpdateArtifact(
      {
        initialization,
        json: true,
        stageParams: () => ({
          root,
          installKind: "package",
          tag: "file:/fixture/candidate.tgz",
          timeoutMs: 1000,
          startedAt: Date.now(),
          progress: {},
          installEnv: {},
        }),
      },
      async () => {
        throw primary;
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome instanceof AggregateError ? outcome.errors : []).toEqual([
      primary,
      cleanupFailure,
    ]);
    expect(stage.close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
