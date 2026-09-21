import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForDead, waitForFixtureFile } from "../../../test/helpers/process-wait.js";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../../test/vitest/vitest.timeouts.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";

let preparedParent: ReturnType<typeof startParent> | undefined;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Keep fixture inputs if either the parent or its independently retained groups are unjoined.
    await preparedParent?.cleanup();
    preparedParent = undefined;
    cleanup();
  }),
);
const url = (key: keyof typeof updateExecutorNativeEntrypoints) =>
  resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints[key]).href;

// The real direct owner, native authority/exec path and lease process probes use
// one compiled graph. Only secure-temp location is redirected into this fixture.
function parentScript() {
  return `
  import fs from "node:fs";
  import { setTimeout as sleep } from "node:timers/promises";
  import { registerSealedRuntime } from ${JSON.stringify(url("sealedRuntime"))};
  import { withUpdateCommandExecutor } from ${JSON.stringify(url("executor"))};
  import { withRetainedUpdateServiceAuthority } from ${JSON.stringify(url("retainedService"))};
  import { execFileUtf8 } from ${JSON.stringify(url("nativeExec"))};
  const { a,b,temp,request,ready,milestones,outcome }=JSON.parse(process.argv[1]);
  fs.writeFileSync(milestones,JSON.stringify({phase:"imports",elapsedMs:performance.now()})+"\\n");
  registerSealedRuntime({json5:null,resolveSecureTempRoot:()=>temp});
  const run={runId: "native-parent-"+process.pid};
  try {
    await withUpdateCommandExecutor(run.runId,async executor=>{
      run.executorFence=await executor.enter(b,{serviceRoot:a});
      fs.appendFileSync(milestones,JSON.stringify({phase:"admitted",elapsedMs:performance.now()})+"\\n");
      fs.writeFileSync(ready+".tmp","ready"); fs.renameSync(ready+".tmp",ready);
      while(!fs.existsSync(request))await sleep(10);
      const {argv,timeout,parallel}=JSON.parse(fs.readFileSync(request,"utf8"));
      fs.appendFileSync(milestones,JSON.stringify({phase:"dispatch",elapsedMs:performance.now()})+"\\n");
      const result=await withRetainedUpdateServiceAuthority(
        {run,root:a,assertCurrent:()=>{}},
        ()=>parallel
          ? Promise.all([execFileUtf8(argv[0],argv.slice(1),{timeout}),execFileUtf8(argv[0],argv.slice(1),{timeout})])
          : execFileUtf8(argv[0],argv.slice(1),{timeout})
      );
      fs.appendFileSync(milestones,JSON.stringify({phase:"settled",elapsedMs:performance.now()})+"\\n");
      fs.writeFileSync(outcome,JSON.stringify(result));
      if((Array.isArray(result)?result:[result]).some(entry=>entry.code!==0))throw Error("native-failed:"+JSON.stringify(result));
    });
  } catch(error) { process.stderr.write(error.message); process.exitCode=1; }
`;
}

function setup() {
  const root = fs.realpathSync(dirs.make("retained-native-parent-"));
  const a = path.join(root, "A");
  const b = path.join(root, "B");
  const temp = path.join(root, "control");
  const controllers = path.join(root, "controllers");
  for (const dir of [a, b, temp, controllers]) {
    fs.mkdirSync(dir);
  }
  return {
    root,
    a,
    b,
    temp,
    controllers,
    started: path.join(root, "started.json"),
    request: path.join(root, "request.json"),
    ready: path.join(root, "parent-ready"),
    milestones: path.join(root, "milestones.jsonl"),
    finish: path.join(root, "finish"),
    effect: path.join(root, "effect"),
    outcome: path.join(root, "outcome.json"),
  };
}

/** Start imports and real executor admission before a test owns its behavior deadline. */
function startParent(killProcessTree: boolean) {
  const fixture = setup();
  const abort = new AbortController();
  let parentPid: number | undefined;
  let dispatched = false;
  let expectedControllers = 0;
  let behaviorTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaning: Promise<void> | undefined;
  const pending = runCommandWithTimeout(
    [process.execPath, "--input-type=module", "-e", parentScript(), "--", JSON.stringify(fixture)],
    {
      input: "",
      beforeInput: (pid) => {
        parentPid = pid;
      },
      signal: abort.signal,
      // Retain the runner's ownership of successful inherited output during startup too.
      timeoutMs: DEFAULT_VITEST_TEST_TIMEOUT_MS,
      killProcessTree,
      ...(killProcessTree ? { requireProcessTreeExtinction: true } : {}),
    },
  );
  const clearBehaviorTimer = () => clearTimeout(behaviorTimer);
  void pending.then(clearBehaviorTimer, clearBehaviorTimer);
  return {
    fixture,
    pid: () => parentPid,
    ready: () =>
      withTestTimeout(
        waitForFixtureFile(fixture.ready, pending, "ready"),
        DEFAULT_VITEST_TEST_TIMEOUT_MS,
        `Fixture parent did not finish import/admission; inspect ${fixture.milestones}`,
      ),
    run(command: { argv: string[]; timeout: number; parallel?: boolean }, timeoutMs: number) {
      if (dispatched) {
        throw new Error("Fixture command was already dispatched");
      }
      dispatched = true;
      // The missing executable has no controller; every Node command records its own receipt.
      expectedControllers = command.argv[0] === process.execPath ? (command.parallel ? 2 : 1) : 0;
      behaviorTimer = setTimeout(
        () => abort.abort(new Error("Fixture behavior deadline expired")),
        timeoutMs,
      );
      fs.writeFileSync(`${fixture.request}.tmp`, JSON.stringify(command));
      fs.renameSync(`${fixture.request}.tmp`, fixture.request);
      return pending;
    },
    cleanup() {
      return (cleaning ??= (async () => {
        clearBehaviorTimer();
        // Every actual fixture controller has this cooperative release path, including timeout cases.
        fs.writeFileSync(fixture.finish, "");
        if (!dispatched) {
          abort.abort();
        }
        try {
          await withTestTimeout(pending, 5000, "Fixture parent did not settle during cleanup");
        } catch {
          abort.abort();
          await withTestTimeout(
            pending.catch(() => undefined),
            5000,
            `Fixture parent did not settle after abort; retaining ${fixture.root}`,
          );
        }
        if (parentPid !== undefined) {
          await waitForDead(parentPid, 5000);
        }
        const receipts = () =>
          fs.readdirSync(fixture.controllers).filter((file) => file.endsWith(".json"));
        // The real owner can settle a timeout or spawn failure before any controller starts.
        if (dispatched && !fs.existsSync(fixture.outcome)) {
          if (expectedControllers === 0) {
            throw new Error(`Native launch did not report settlement; retaining ${fixture.root}`);
          }
          // Unknown completion still needs every bound controller accounted for below.
          await expect.poll(() => receipts().length, { timeout: 5000 }).toBe(expectedControllers);
        }
        for (const receipt of receipts()) {
          const native: { pid: number; gate: number } = JSON.parse(
            fs.readFileSync(path.join(fixture.controllers, receipt), "utf8"),
          );
          await waitForDead(native.pid, 5000);
          await waitForDead(native.gate, 5000);
          await expect
            .poll(() => isChildProcessTreeAlive({ pid: native.gate }), { timeout: 5000 })
            .toBe(false);
        }
        // Do not release, rewrite, or reacquire retained leases here. In particular,
        // a signal still leaves both rows current until this test's private directory is retired.
      })());
    },
  };
}

function useParent(killProcessTree: boolean) {
  beforeEach(async () => {
    if (preparedParent) {
      throw new Error(`Previous fixture cleanup is unresolved: ${preparedParent.fixture.root}`);
    }
    preparedParent = startParent(killProcessTree);
    await preparedParent.ready();
  }, DEFAULT_VITEST_TEST_TIMEOUT_MS);
  return () => {
    if (!preparedParent) {
      throw new Error("Missing prepared fixture parent");
    }
    return preparedParent;
  };
}

function controllerScript(fixture: ReturnType<typeof setup>, script: string): string {
  return `
    const fs=require("node:fs");
    const receipt=${JSON.stringify(fixture.controllers)}+"/"+process.pid+".json";
    fs.writeFileSync(receipt+".tmp",JSON.stringify({pid:process.pid,gate:process.ppid}));
    fs.renameSync(receipt+".tmp",receipt);
    const started=${JSON.stringify(fixture.started)};
    fs.copyFileSync(receipt,receipt+".started");
    fs.renameSync(receipt+".started",started);
    const cleanup=setInterval(()=>{
      if(fs.existsSync(${JSON.stringify(fixture.finish)})){
        fs.writeFileSync(${JSON.stringify(fixture.effect)},"finished");
        process.exit(0);
      }
    },10);
    cleanup.unref();
    ${script}
  `;
}

describe.skipIf(process.platform === "win32")("POSIX bound native control", () => {
  describe("retained parent and gate loss", () => {
    const parent = useParent(false);
    it.each(["parent", "gate"] as const)(
      "retains both roots after %s loss while its real native controller survives",
      async (loss) => {
        const prepared = parent();
        const fixture = prepared.fixture;
        const pending = prepared.run(
          {
            argv: [process.execPath, "-e", controllerScript(fixture, "setInterval(()=>{},10);")],
            timeout: 15000,
          },
          20000,
        );
        const parentPid = prepared.pid();
        let native: { pid: number; gate: number } | undefined;
        try {
          await expect.poll(() => fs.existsSync(fixture.started), { timeout: 10000 }).toBe(true);
          native = JSON.parse(fs.readFileSync(fixture.started, "utf8"));
          if (!native || !parentPid) {
            throw new Error("Missing live fixture process receipt");
          }
          process.kill(parentPid, "SIGKILL");
          await pending;
          if (loss === "gate") {
            process.kill(native.gate, "SIGKILL");
          }
          process.kill(native.pid, 0);
          const store = createManagedHandoffLeaseStore({
            databasePath: path.join(fixture.temp, "managed-update-handoffs.sqlite"),
            serviceManagerEnv: {},
          });
          for (const root of [fixture.a, fixture.b]) {
            expect(store.acquire(root, randomUUID(), { kind: "update" }).kind).toBe("busy");
          }
          expect(fs.existsSync(fixture.effect)).toBe(false);
          fs.writeFileSync(fixture.finish, "");
          await expect.poll(() => fs.existsSync(fixture.effect), { timeout: 5000 }).toBe(true);
          // Release is possible only after the recorded gate AND its actual native
          // lineage disappear. No absent PID or killed parent alone certifies this.
          for (const root of [fixture.a, fixture.b]) {
            await expect
              .poll(
                () => {
                  const admitted = store.acquire(root, randomUUID(), { kind: "update" });
                  if (admitted.kind !== "acquired") {
                    return false;
                  }
                  return store.release(admitted.lease);
                },
                { timeout: 5000 },
              )
              .toBe(true);
          }
        } finally {
          fs.writeFileSync(fixture.finish, "");
          await pending;
          if (native) {
            await expect.poll(() => fs.existsSync(fixture.effect), { timeout: 5000 }).toBe(true);
          }
        }
      },
      30000,
    );
  });

  describe("native outcomes", () => {
    const parent = useParent(true);

    it.each([
      {
        name: "nonzero",
        script:
          'process.stdout.write("raw-out");process.stderr.write("raw-err");process.exitCode=7;',
        expected: { code: 7, termination: "exit", stdout: "raw-out", stderr: "raw-err" },
      },
      {
        name: "signal",
        script: 'process.kill(process.pid,"SIGTERM");',
        expected: { termination: "signal" },
      },
      {
        name: "timeout",
        script: "setInterval(()=>{},10);",
        expected: { code: 124, termination: "timeout" },
      },
      {
        name: "missing binary",
        script: "",
        expected: { code: 1, termination: "error", errorCode: "ENOENT" },
      },
      {
        name: "healthy",
        script: 'process.stdout.write("raw-out");process.stderr.write("raw-err");',
        expected: { code: 0, termination: "exit", stdout: "raw-out", stderr: "raw-err" },
      },
    ])(
      "preserves real native $name result or cleanup uncertainty through the bound gate",
      async ({ name, script, expected }) => {
        const prepared = parent();
        const fixture = prepared.fixture;
        const result = await prepared.run(
          {
            argv:
              name === "missing binary"
                ? [path.join(fixture.root, "missing-native")]
                : [process.execPath, "-e", controllerScript(fixture, script)],
            timeout: name === "timeout" ? 1000 : 10000,
          },
          15000,
        );
        if (name === "signal") {
          // The shared runner deliberately marks a child-requested signal uncertain.
          // Do not convert it to a settled native failure or release retained roots.
          expect(result.code).toBe(1);
          expect(result.stderr).toContain(
            "Command cleanup could not confirm that owned work stopped",
          );
          expect(fs.existsSync(fixture.outcome)).toBe(false);
          const store = createManagedHandoffLeaseStore({
            databasePath: path.join(fixture.temp, "managed-update-handoffs.sqlite"),
            serviceManagerEnv: {},
          });
          for (const root of [fixture.a, fixture.b]) {
            expect(store.read(root).kind).toBe("current");
          }
        } else {
          expect(fs.existsSync(fixture.outcome), result.stderr).toBe(true);
          expect(JSON.parse(fs.readFileSync(fixture.outcome, "utf8"))).toMatchObject(expected);
          expect(result.code, result.stderr).toBe(name === "healthy" ? 0 : 1);
        }
      },
      20000,
    );

    it("serializes real concurrent reads under one retained executor", async () => {
      const prepared = parent();
      const fixture = prepared.fixture;
      const settled = await prepared.run(
        {
          parallel: true,
          timeout: 10000,
          argv: [
            process.execPath,
            "-e",
            controllerScript(fixture, 'setTimeout(()=>process.stdout.write("read"),30);'),
          ],
        },
        15000,
      );
      expect(settled.code, settled.stderr).toBe(0);
      const results = JSON.parse(fs.readFileSync(fixture.outcome, "utf8"));
      expect(results).toHaveLength(2);
      expect(results).toEqual([
        expect.objectContaining({ code: 0, stdout: "read" }),
        expect.objectContaining({ code: 0, stdout: "read" }),
      ]);
    });
  });
});

it("declines Windows before invoking native control without Job custody", async () => {
  const original = process.platform;
  let invoked = false;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await expect(
      withRetainedUpdateServiceAuthority(
        { run: { runId: "no-effects", env: {} }, root: "unused", assertCurrent: () => undefined },
        async () => {
          invoked = true;
        },
      ),
    ).rejects.toThrow("Windows Job custody");
    expect(invoked).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

it("never retries a refused scoped runner and leaves nested legacy native scopes unchanged", async () => {
  const fixture = setup();
  const argv = [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(fixture.effect)},"unexpected");`,
  ];
  let calls = 0;
  await withGatewayServiceUpdateAuthority(
    () => undefined,
    async () => {
      const refused = await execFileUtf8(process.execPath, argv);
      expect(refused).toMatchObject({ code: 1, termination: "error", errorCode: "EACCES" });
      expect(calls).toBe(1);
      expect(fs.existsSync(fixture.effect)).toBe(false);
      const ordinary = await withGatewayServiceUpdateAuthority(
        () => undefined,
        () => execFileUtf8(process.execPath, ["-e", 'process.stdout.write("ordinary-native");']),
      );
      expect(ordinary).toMatchObject({ code: 0, stdout: "ordinary-native", termination: "exit" });
      expect(calls).toBe(1);
    },
    {
      nativeCommand: async () => {
        calls += 1;
        throw Object.assign(new Error("fixture native refusal"), { code: "EACCES" });
      },
    },
  );
});
