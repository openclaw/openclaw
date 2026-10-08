import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fileLock from "@openclaw/fs-safe/file-lock";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resolveDistArtifactLockPath } from "../../scripts/lib/dist-artifact-lock.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runLinuxMemoryCommand } from "../../scripts/lib/managed-memory.mts";
import { inspectSourceUpdateArtifacts } from "../../scripts/lib/source-update-artifact-preflight.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { getProcessInstanceStartTime, isPidAlive } from "../../src/shared/pid-alive.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { waitForDead } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import {
  hasSemanticTestBackend,
  overrideNativeFixtureExecutable,
} from "./native-boundary-fixture.js";

const uid = process.getuid?.();
const runtime = uid === undefined ? undefined : path.join("/run/user", String(uid));
const managerRoute: NodeJS.ProcessEnv = runtime
  ? {
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=" + path.join(runtime, "bus"),
    }
  : {};
const nativeAvailable =
  process.platform === "linux" && hasSemanticTestBackend({ ...process.env, ...managerRoute });

vi.mock("@openclaw/fs-safe/file-lock", async (original) => ({
  ...(await original<typeof import("@openclaw/fs-safe/file-lock")>()),
  acquireFileLock: vi.fn(),
}));
const actual = await vi.importActual<typeof import("@openclaw/fs-safe/file-lock")>(
  "@openclaw/fs-safe/file-lock",
);
const fixture = createFixtureLifetime();
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
beforeEach(() => {
  vi.mocked(fileLock.acquireFileLock).mockReset().mockImplementation(actual.acquireFileLock);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});

function scenario(launch: "managed" | "raw" | "empty") {
  const root = fs.realpathSync(fixture.createTempDir("artifact-custody-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "dist"));
  const artifact = path.join(root, "dist", "previous.js");
  fs.writeFileSync(artifact, "previous generation");
  createVitestResourceOwner(root);
  const source = path.join(root, "leaf");
  const pidFile = path.join(root, "leaf.pid");
  const leaf =
    fixtureReceiptClientSource(receipts.endpoint) +
    "process.send(process.pid, () => process.disconnect()); await awaitRelease(" +
    JSON.stringify(source) +
    ', "finish");';
  const workload = [
    'import { spawn } from "node:child_process";',
    'import fs from "node:fs";',
    'const child = spawn(process.execPath, ["--input-type=module", "-e", ' +
      JSON.stringify(leaf) +
      "],",
    '{ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });',
    'child.once("message", pid => { fs.writeFileSync(' +
      JSON.stringify(pidFile) +
      ", String(pid)); child.unref(); });",
  ].join("\n");
  const lockUrl = pathToFileURL(path.resolve("scripts/lib/dist-artifact-lock.mts")).href;
  const commandUrl = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href;
  const replacement =
    "import { acquireFileLock as acquire } from " +
    JSON.stringify(import.meta.resolve("@openclaw/fs-safe/file-lock")) +
    ";" +
    'export async function acquireFileLock(...args) { const lock=await acquire(...args); return {...lock, release: async()=>{throw new Error("fixture interrupted unlink");}};}';
  const work =
    launch === "empty"
      ? "async () => {}"
      : launch === "managed"
        ? '()=>runManagedCommand({bin:process.execPath,args:["--input-type=module","-e",' +
          JSON.stringify(workload) +
          '],stdio:"ignore",requireProcessTreeExit:true})'
        : 'async()=>{execFileSync(process.execPath,["--input-type=module","-e",' +
          JSON.stringify(workload) +
          '],{stdio:"ignore"});}';
  const owner = [
    'import assert from "node:assert/strict";',
    'import {execFileSync} from "node:child_process";',
    'import {registerHooks} from "node:module";',
    'registerHooks({resolve(s,c,next) { if(s === "@openclaw/fs-safe/file-lock" && c.parentURL === ' +
      JSON.stringify(lockUrl) +
      ') return {shortCircuit:true,url:"data:text/javascript,"+encodeURIComponent(' +
      JSON.stringify(replacement) +
      ")}; return next(s,c); }});",
    "const {withDistArtifactOwnership}=await import(" + JSON.stringify(lockUrl) + ");",
    "const {runManagedCommand}=await import(" + JSON.stringify(commandUrl) + ");",
    "await assert.rejects(withDistArtifactOwnership(process.cwd()," +
      work +
      "),/fixture interrupted unlink/);",
  ].join("\n");
  const directory = resolveDistArtifactLockPath(root);
  return {
    root,
    directory,
    artifact,
    ownerFile: path.join(directory, "owner.json"),
    command: {
      bin: requireNodeTool("node"),
      args: ["--input-type=module", "-e", owner],
      cwd: root,
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    },
    pid: () => Number(fs.readFileSync(pidFile, "utf8")),
    async finish(signal: AbortSignal) {
      receipts.release(source, "finish");
      if (fs.existsSync(pidFile)) {
        await withinTest(receipts.waitForExit(source), signal);
        await waitForDead(Number(fs.readFileSync(pidFile, "utf8")), signal);
      }
    },
  };
}

async function expectRefused(root: string) {
  const result = await inspectSourceUpdateArtifacts(root).catch((error: unknown) => error);
  if (result instanceof Error) {
    expect(result.message).toContain("custody unresolved");
    return;
  }
  if (result && typeof result === "object" && "lock" in result) {
    await (result as Awaited<ReturnType<typeof inspectSourceUpdateArtifacts>>).lock?.release();
  }
  throw new Error("Source admission reclaimed without complete native custody");
}

it.skipIf(process.platform === "win32").for(["managed", "raw", "empty"] as const)(
  "never treats %s callback/group settlement as complete descendant custody",
  async (launch, { signal }) =>
    fixture.run(async () => {
      const proof = scenario(launch);
      try {
        execFileSync(proof.command.bin, proof.command.args, {
          cwd: proof.root,
          env: proof.command.env,
        });
        if (launch !== "empty") {
          expect(isPidAlive(proof.pid())).toBe(true);
        }
        const raw = fs.readFileSync(proof.ownerFile, "utf8");
        await expectRefused(proof.root);
        expect(fs.readFileSync(proof.ownerFile, "utf8")).toBe(raw);
        expect(fs.readFileSync(proof.artifact, "utf8")).toBe("previous generation");
        await proof.finish(signal);
        // Even a later empty group cannot reconstruct missing whole-tree custody.
        await expectRefused(proof.root);
        fs.writeFileSync(
          proof.ownerFile,
          JSON.stringify({
            ...JSON.parse(raw),
            pid: process.pid,
            startIdentity: (getProcessInstanceStartTime(process.pid) ?? 1) - 1,
          }),
        );
        await expectRefused(proof.root);
      } finally {
        await proof.finish(signal);
      }
    }),
);

// Reuse the existing semantic-backend qualification. A skip is not native proof;
// a qualified run creates only its task-owned scope, never service configuration.
it.runIf(nativeAvailable)(
  "does not infer descendant custody from the retirement of a memory scope",
  async ({ signal }) =>
    fixture.run(async () => {
      const proof = scenario("raw");
      const exited = createDeferred();
      const cleanup = createDeferred();
      const contained = fixture.track(
        runLinuxMemoryCommand(
          {
            ...proof.command,
            env: { ...proof.command.env, ...managerRoute },
            memoryLimitBytes: 256 * 1024 ** 2,
            signal,
          },
          async (command) => {
            const status = await runManagedCommand(command);
            exited.resolve();
            await withinTest(cleanup.promise, signal);
            return status;
          },
        ),
      );
      try {
        await awaitGateBeforeSettlement(
          exited.promise,
          contained,
          "Contained owner did not reach cleanup",
        );
        const raw = fs.readFileSync(proof.ownerFile, "utf8");
        expect(isPidAlive(proof.pid())).toBe(true);
        await expectRefused(proof.root);
        cleanup.resolve();
        expect(await contained).toBe(0);
        expect(isPidAlive(proof.pid())).toBe(false);

        await expectRefused(proof.root);
        expect(fs.readFileSync(proof.ownerFile, "utf8")).toBe(raw);
        expect(fs.readFileSync(proof.artifact, "utf8")).toBe("previous generation");
      } finally {
        cleanup.resolve();
        await contained;
        await proof.finish(signal);
      }
    }),
);

function nativeCompilerScenario({
  migrate = false,
  holdTerm = false,
  metrics = false,
  changeIdentity = false,
  interruptUnlink = true,
} = {}) {
  const root = fs.realpathSync(fixture.createTempDir("artifact-native-entry-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist/previous.js"), "previous generation");
  createVitestResourceOwner(root);
  const source = path.join(root, "compiler");
  const leafSource = path.join(root, "leaf");
  const unit = "artifact-proof-" + randomUUID() + ".scope";
  const guardianFile = path.join(root, "guardian.pid");
  const runtimeFile = path.join(root, "runtime.json");
  const pidFile = path.join(root, "leaf.pid");
  const leaf =
    fixtureReceiptClientSource(receipts.endpoint) +
    (holdTerm
      ? 'process.on("SIGTERM",()=>sendReceipt(' + JSON.stringify(leafSource) + ',"term"));'
      : "") +
    'import fs from "node:fs"; fs.writeFileSync(' +
    JSON.stringify(pidFile) +
    ",String(process.pid));" +
    "sendReceipt(" +
    JSON.stringify(leafSource) +
    ',"ready"); await awaitRelease(' +
    JSON.stringify(leafSource) +
    ',"finish");';
  const compiler = path.join(root, "compiler.mjs");
  fs.writeFileSync(
    compiler,
    "#!" +
      requireNodeTool("node") +
      "\n" +
      fixtureReceiptClientSource(receipts.endpoint) +
      'import {spawn} from "node:child_process"; import fs from "node:fs";' +
      'const parentStat=fs.readFileSync("/proc/"+process.ppid+"/stat","utf8");' +
      (metrics ? "if(false) " : "") +
      "fs.writeFileSync(" +
      JSON.stringify(guardianFile) +
      ',parentStat.slice(parentStat.lastIndexOf(")")+2).split(" ")[1]);' +
      "const child=spawn(" +
      (migrate ? '"systemd-run"' : "process.execPath") +
      "," +
      JSON.stringify(
        migrate
          ? [
              "--user",
              "--scope",
              "--quiet",
              "--unit=" + unit,
              requireNodeTool("node"),
              "--input-type=module",
              "-e",
              leaf,
            ]
          : ["--input-type=module", "-e", leaf],
      ) +
      ',{detached:true,stdio:"ignore"}); child.unref();' +
      "sendReceipt(" +
      JSON.stringify(source) +
      ',"ready"); await awaitRelease(' +
      JSON.stringify(source) +
      ',"finish");',
    { mode: 0o700 },
  );
  overrideNativeFixtureExecutable(root, compiler);
  const lockUrl = pathToFileURL(path.resolve("scripts/lib/dist-artifact-lock.mts")).href;
  const scriptUrl = pathToFileURL(path.resolve("scripts/run-tsgo.mts")).href;
  const replacement =
    "import {acquireFileLock as acquire} from " +
    JSON.stringify(import.meta.resolve("@openclaw/fs-safe/file-lock")) +
    ";" +
    'export async function acquireFileLock(...args){const lock=await acquire(...args);return {...lock,release:async()=>{throw new Error("fixture interrupted unlink");}};}';
  const runtimeReplacement =
    'import fs from "node:fs"; import path from "node:path"; export * from ' +
    JSON.stringify(pathToFileURL(path.resolve("scripts/lib/vitest-worker-run.mts")).href) +
    ";" +
    "import {createVitestWorkerRun as create} from " +
    JSON.stringify(pathToFileURL(path.resolve("scripts/lib/vitest-worker-run.mts")).href) +
    ";" +
    "export function createVitestWorkerRun(...args){const run=create(...args);return {...run,prepare:async()=>{" +
    "const manifest=await run.prepare(); fs.writeFileSync(" +
    JSON.stringify(runtimeFile) +
    ',JSON.stringify({directory:run.descriptor.directory,testRegistry:Object.keys(manifest.inputs).some(file=>file.endsWith("/scripts/lib/vitest-worker-build-entries.mts")),nativeBootstrap:Object.keys(manifest.inputs).some(file=>file.endsWith("/scripts/lib/dist-artifact-native.mts")),identity:fs.readFileSync(path.join(run.descriptor.directory,".vitest-resource-owner/owner"),"utf8")})); return manifest;}};}';
  const identityReplacement =
    'import fs from "node:fs"; export * from ' +
    JSON.stringify(pathToFileURL(path.resolve("src/shared/pid-alive.ts")).href) +
    ";" +
    "import {getProcessInstanceStartTime as actual} from " +
    JSON.stringify(pathToFileURL(path.resolve("src/shared/pid-alive.ts")).href) +
    ";" +
    "export function getProcessInstanceStartTime(pid){const birth=actual(pid);if(pid!==process.pid&&birth!==null){" +
    'const stat=fs.readFileSync("/proc/"+pid+"/stat","utf8");fs.writeFileSync(' +
    JSON.stringify(guardianFile) +
    ',stat.slice(stat.lastIndexOf(")")+2).split(" ")[1]);return birth+1;}return birth;}';
  const owner =
    'import assert from "node:assert/strict"; import {registerHooks} from "node:module";' +
    'registerHooks({resolve(s,c,next){if(s==="@openclaw/fs-safe/file-lock"&&c.parentURL===' +
    JSON.stringify(lockUrl) +
    ')return {shortCircuit:true,url:"data:text/javascript,"+encodeURIComponent(' +
    JSON.stringify(
      interruptUnlink
        ? replacement
        : "export {acquireFileLock} from " +
            JSON.stringify(import.meta.resolve("@openclaw/fs-safe/file-lock")) +
            ";",
    ) +
    ')};if(s==="./vitest-worker-run.mts"&&c.parentURL===' +
    JSON.stringify(pathToFileURL(path.resolve("scripts/lib/dist-artifact-native.mts")).href) +
    ')return {shortCircuit:true,url:"data:text/javascript,"+encodeURIComponent(' +
    JSON.stringify(runtimeReplacement) +
    ")};" +
    (changeIdentity
      ? 'if(s==="../../src/shared/pid-alive.ts"&&c.parentURL===' +
        JSON.stringify(pathToFileURL(path.resolve("scripts/lib/dist-artifact-identity.mts")).href) +
        ')return {shortCircuit:true,url:"data:text/javascript,"+encodeURIComponent(' +
        JSON.stringify(identityReplacement) +
        ")};"
      : "") +
    "return next(s,c);}});" +
    "process.argv=[process.execPath," +
    JSON.stringify(path.resolve("scripts/run-tsgo.mts")) +
    "];" +
    (interruptUnlink
      ? "await assert.rejects(import(" +
        JSON.stringify(scriptUrl) +
        "),/fixture interrupted unlink|Source changed during compiled subprocess invocation|Foreign artifact claim|Artifact native command did not provide complete settlement/);"
      : "await import(" + JSON.stringify(scriptUrl) + ");");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...managerRoute,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
  };
  if (metrics) {
    env.OPENCLAW_TSGO_METRICS_DIR = path.join(root, "metrics");
  } else {
    delete env.OPENCLAW_TSGO_METRICS_DIR;
  }
  // These fixtures exercise bare native Node, not a user-supplied preload closure.
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NAPI_RS_NATIVE_LIBRARY_PATH",
    "NAPI_RS_WASI_FLAVOR",
    "NAPI_RS_FORCE_WASI",
  ]) {
    delete env[key];
  }
  let child: ChildProcess | undefined;
  const diagnostics: string[] = [];
  const completion = fixture.track(
    runManagedCommand({
      bin: requireNodeTool("node"),
      args: ["--input-type=module", "-e", owner],
      cwd: root,
      env,
      stdio: "pipe",
      requireProcessTreeExit: true,
      onReady: (started) => {
        child = started;
        started.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));
      },
    }),
  );
  return {
    root,
    completion,
    directory: resolveDistArtifactLockPath(root),
    async ready(signal: AbortSignal) {
      await awaitGateBeforeSettlement(
        withinTest(receipts.waitFor(leafSource, "ready"), signal),
        completion,
        "Native compiler exited before descendant admission",
      );
      await withinTest(receipts.waitFor(source, "ready"), signal);
      if (!metrics) {
        // Missing observation is a fixture failure, never a silently skipped proof.
        expect(JSON.parse(fs.readFileSync(runtimeFile, "utf8"))).toMatchObject({
          testRegistry: false,
          nativeBootstrap: true,
        });
      }
      if (migrate) {
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        expect(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8")).toContain(unit);
        const guardian = Number(fs.readFileSync(guardianFile, "utf8"));
        expect(fs.readFileSync(`/proc/${guardian}/cgroup`, "utf8")).not.toContain(unit);
      }
    },
    pid: () => Number(fs.readFileSync(pidFile, "utf8")),
    stopOwner: () => child?.kill("SIGKILL"),
    termObserved: (signal: AbortSignal) => withinTest(receipts.waitFor(leafSource, "term"), signal),
    finishLeaf: () => receipts.release(leafSource, "finish"),
    cancelOwner: (signal: NodeJS.Signals = "SIGTERM") => child?.kill(signal),
    changeSource: () => fs.appendFileSync(compiler, "\n// Changed fixture compiler source\n"),
    finishRoot: () => receipts.release(source, "finish"),
    async cleanup(signal: AbortSignal) {
      receipts.release(source, "finish");
      receipts.release(leafSource, "finish");
      await completion;
      if (fs.existsSync(pidFile)) {
        await waitForDead(Number(fs.readFileSync(pidFile, "utf8")), signal);
      }
      if (fs.existsSync(guardianFile)) {
        await waitForDead(Number(fs.readFileSync(guardianFile, "utf8")), signal);
      }
      if (fs.existsSync(runtimeFile)) {
        const owned = JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as {
          directory: string;
          identity: string;
        };
        const identityFile = path.join(owned.directory, ".vitest-resource-owner/owner");
        // After controller loss the known native guardian must join before its
        // task generation is removed. A reused slot belongs to someone else.
        if (
          fs.existsSync(identityFile) &&
          fs.readFileSync(identityFile, "utf8") === owned.identity
        ) {
          await fs.promises.rm(owned.directory, { recursive: true });
        }
      }
    },
    identityWasQueried: () => fs.existsSync(guardianFile),
    entryStarted: (signal: AbortSignal) => withinTest(receipts.waitFor(source, "ready"), signal),
    diagnostics: () => diagnostics.join(""),
    foreignEntry(custodyId: string) {
      const foreignSource = path.join(root, "foreign");
      const file = path.join(root, "foreign.mjs");
      fs.writeFileSync(
        file,
        fixtureReceiptClientSource(receipts.endpoint) +
          "sendReceipt(" +
          JSON.stringify(foreignSource) +
          ',"entered");await awaitRelease(' +
          JSON.stringify(foreignSource) +
          ',"finish");',
      );
      const foreignCompletion = fixture.track(
        runManagedCommand({
          bin: requireNodeTool("node"),
          cwd: root,
          env,
          stdio: ["pipe", "ignore", "ignore"],
          onReady: (foreignChild) => {
            foreignChild.stdin?.on("error", () => {});
            foreignChild.stdin?.end(custodyId + "\n");
          },
          requireProcessTreeExit: true,
          args: [
            path.resolve("scripts/lib/dist-artifact-ownership.mts"),
            "--native-custody",
            custodyId,
            pathToFileURL(file).href,
          ],
        }),
      );
      return {
        outcome: Promise.race([
          foreignCompletion.then((code) => ({ entered: false, code })),
          receipts
            .waitFor(foreignSource, "entered")
            .then(() => ({ entered: true, code: undefined })),
        ]),
        async close() {
          receipts.release(foreignSource, "finish");
          await foreignCompletion;
        },
      };
    },
  };
}

it.runIf(process.platform === "linux").for([
  { migrate: false, ending: "settle" },
  { migrate: true, ending: "settle" },
  { migrate: true, ending: "kill" },
  { migrate: false, ending: "change" },
  { migrate: false, ending: "cancel" },
] as const)(
  "native compiler custody: $ending, migrate=$migrate",
  async ({ migrate, ending }, { signal, skip }) =>
    fixture.run(async () => {
      if (migrate && !nativeAvailable) {
        skip();
      }
      const proof = nativeCompilerScenario({ migrate, holdTerm: ending === "kill" });
      try {
        await proof.ready(signal);
        expect(isPidAlive(proof.pid())).toBe(true);
        await expectRefused(proof.root);
        const ownerFile = path.join(proof.directory, "owner.json");
        const raw = fs.readFileSync(ownerFile, "utf8");
        const payload = JSON.parse(raw) as { custodyId: string; treeOwnership: string };
        expect(payload.treeOwnership).toBe("linux-subreaper");
        if (ending === "kill") {
          proof.stopOwner();
        } else if (ending === "cancel") {
          proof.cancelOwner();
        } else {
          if (ending === "change") {
            proof.changeSource();
          }
          proof.finishRoot();
        }
        expect(await proof.completion, proof.diagnostics()).toBe(ending === "kill" ? 137 : 0);
        console.info(
          proof
            .diagnostics()
            .split("\n")
            .filter((line) => /local cache|prepared .* in/.test(line))
            .join("\n"),
        );
        if (ending === "kill") {
          await proof.termObserved(signal);
          expect(isPidAlive(proof.pid())).toBe(true);
          await expectRefused(proof.root);
          proof.finishLeaf();
        }
        await waitForDead(proof.pid(), signal);
        if (ending === "kill" || ending === "change") {
          // Cleanup can finish, but absent or invalidated settlement remains unknown.
          await expectRefused(proof.root);
          expect(fs.readFileSync(ownerFile, "utf8")).toBe(raw);
        } else {
          const settled = path.join(proof.directory, payload.custodyId, "settled");
          expect(fs.readFileSync(settled, "utf8")).toBe(raw);
          if (ending === "settle" && !migrate) {
            for (const changed of [
              {
                ...payload,
                pid: process.pid,
                startIdentity: getProcessInstanceStartTime(process.pid),
              },
              { ...payload, processScope: "foreign boot or namespace" },
              { ...payload, custodyId: randomUUID() },
            ]) {
              const bytes = JSON.stringify(changed);
              fs.writeFileSync(ownerFile, bytes);
              fs.writeFileSync(settled, bytes);
              await expectRefused(proof.root);
              expect(fs.readFileSync(ownerFile, "utf8")).toBe(bytes);
            }
            fs.writeFileSync(ownerFile, raw);
            fs.writeFileSync(settled, "partial settlement receipt");
            await expectRefused(proof.root);
            fs.writeFileSync(settled, raw);
            // The native compare-before-unlink guard must survive a final owner change.
            const successor = JSON.stringify({ pid: process.pid, startedAt: "successor" });
            vi.mocked(fileLock.acquireFileLock).mockImplementation((target, options) =>
              actual.acquireFileLock(target, {
                ...options,
                shouldRemoveStaleLock: async (snapshot) => {
                  const approved = await options.shouldRemoveStaleLock?.(snapshot);
                  if (approved) {
                    fs.writeFileSync(ownerFile, successor);
                  }
                  return approved === true;
                },
              }),
            );
            await expectRefused(proof.root);
            expect(fs.readFileSync(ownerFile, "utf8")).toBe(successor);
            vi.mocked(fileLock.acquireFileLock).mockImplementation(actual.acquireFileLock);
            // Model reuse of the retired numeric PID, not death of this live process.
            const reused = JSON.stringify({
              ...JSON.parse(raw),
              pid: process.pid,
              startIdentity: (getProcessInstanceStartTime(process.pid) ?? 1) - 1,
            });
            fs.writeFileSync(ownerFile, reused);
            fs.writeFileSync(settled, reused);
          }
          const prepared = await inspectSourceUpdateArtifacts(proof.root);
          expect(isPidAlive(process.pid)).toBe(true);
          expect(prepared.sourceRuntimePrepared).toBe(true);
          await prepared.lock?.release();
          expect(fs.readdirSync(proof.directory)).toEqual([]);
        }
        expect(fs.readFileSync(path.join(proof.root, "dist/previous.js"), "utf8")).toBe(
          "previous generation",
        );
      } finally {
        await proof.cleanup(signal);
      }
    }),
);

it.runIf(process.platform === "linux")(
  "refuses a matching-ID entry outside native custody",
  async ({ signal }) =>
    fixture.run(async () => {
      const proof = nativeCompilerScenario();
      let foreign: ReturnType<typeof proof.foreignEntry> | undefined;
      try {
        await proof.ready(signal);
        const owner = JSON.parse(
          fs.readFileSync(path.join(proof.directory, "owner.json"), "utf8"),
        ) as { custodyId: string };
        foreign = proof.foreignEntry(owner.custodyId);
        const observed = await withinTest(foreign.outcome, signal);
        if (observed.entered) {
          proof.finishRoot();
          await proof.completion;
          // Before the fix, another process's live claim was erased and this admits.
          await expectRefused(proof.root);
        }
        expect(observed).toEqual({ entered: false, code: 1 });
        const claim = path.join(proof.directory, owner.custodyId, "child-" + process.pid);
        const unknown = JSON.stringify({
          pid: process.pid,
          startIdentity: getProcessInstanceStartTime(process.pid),
        });
        fs.writeFileSync(claim, unknown);
        proof.finishRoot();
        expect(await proof.completion, proof.diagnostics()).toBe(0);
        await expectRefused(proof.root);
        expect(fs.readFileSync(claim, "utf8")).toBe(unknown);
      } finally {
        await foreign?.close();
        await proof.cleanup(signal);
      }
    }),
);

it.runIf(process.platform === "linux")(
  "metrics source entry retains noncertifying custody",
  async ({ signal }) =>
    fixture.run(async () => {
      const proof = nativeCompilerScenario({ metrics: true });
      try {
        await proof.ready(signal);
        proof.finishRoot();
        expect(await proof.completion, proof.diagnostics()).toBe(0);
        expect(isPidAlive(proof.pid())).toBe(true);
        const owner = JSON.parse(
          fs.readFileSync(path.join(proof.directory, "owner.json"), "utf8"),
        ) as { treeOwnership?: string };
        expect(owner.treeOwnership).toBeUndefined();
        await expectRefused(proof.root);
      } finally {
        await proof.cleanup(signal);
      }
    }),
);

it.runIf(process.platform === "linux")(
  "refuses a reused native root identity before granting entry",
  async ({ signal }) =>
    fixture.run(async () => {
      const proof = nativeCompilerScenario({ changeIdentity: true });
      try {
        const result = await Promise.race([
          proof.completion,
          proof.entryStarted(signal).then(() => {
            throw new Error("PID-reuse fixture unexpectedly admitted the compiler");
          }),
        ]);
        expect(result, proof.diagnostics()).toBe(0);
        expect(proof.identityWasQueried()).toBe(true);
        await expectRefused(proof.root);
      } finally {
        await proof.cleanup(signal);
      }
    }),
);

it.runIf(process.platform === "linux").for([
  ["SIGINT", 130],
  ["SIGHUP", 129],
] as const)(
  "native entry preserves %s after joined cancellation",
  async ([received, code], { signal }) =>
    fixture.run(async () => {
      const proof = nativeCompilerScenario({ interruptUnlink: false });
      try {
        await proof.ready(signal);
        proof.cancelOwner(received);
        expect(await proof.completion, proof.diagnostics()).toBe(code);
        expect(fs.readdirSync(proof.directory)).toEqual([]);
      } finally {
        await proof.cleanup(signal);
      }
    }),
);
