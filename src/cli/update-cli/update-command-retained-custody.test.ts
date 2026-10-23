import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForDead, waitForFixtureFile } from "../../../test/helpers/process-wait.js";
import { withinTest, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../../test/vitest/vitest.timeouts.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";

const NATIVE_CLEANUP_GUARD_MS = 5_000;
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

function parentScript() {
  return `
  import fs from "node:fs";
  import { setTimeout as sleep } from "node:timers/promises";
  import { registerSealedRuntime } from ${JSON.stringify(url("sealedRuntime"))};
  import { withUpdateCommandExecutor } from ${JSON.stringify(url("executor"))};
  import { withRetainedUpdateServiceAuthority } from ${JSON.stringify(url("retainedService"))};
  import { execFileUtf8 } from ${JSON.stringify(url("nativeExec"))};
  const { a,b,temp,request,ready,outcome }=JSON.parse(process.argv[1]);
  registerSealedRuntime({json5:null,resolveSecureTempRoot:()=>temp});
  const run={runId: "native-parent-"+process.pid};
  try {
    await withUpdateCommandExecutor(run.runId,async executor=>{
      run.executorFence=await executor.enter(b,{serviceRoot:a});
      fs.writeFileSync(ready+".tmp","ready"); fs.renameSync(ready+".tmp",ready);
      while(!fs.existsSync(request))await sleep(10);
      const {argv,timeout,parallel}=JSON.parse(fs.readFileSync(request,"utf8"));
      const result=await withRetainedUpdateServiceAuthority(
        {run,root:a,assertCurrent:()=>{}},
        ()=>parallel
          ? Promise.all([execFileUtf8(argv[0],argv.slice(1),{timeout}),execFileUtf8(argv[0],argv.slice(1),{timeout})])
          : execFileUtf8(argv[0],argv.slice(1),{timeout})
      );
      fs.writeFileSync(outcome,JSON.stringify(result));
      if((Array.isArray(result)?result:[result]).some(entry=>entry.code!==0))throw Error("native-failed:"+JSON.stringify(result));
    });
  } catch(error) { process.stderr.write(error.message); process.exitCode=1; }
`;
}

function setup() {
  const root = fs.realpathSync(dirs.make("retained-native-parent-"));
  const file = (name: string) => path.join(root, name);
  const fixture = {
    root,
    a: file("A"),
    b: file("B"),
    temp: file("control"),
    controllers: file("controllers"),
    started: file("started.json"),
    request: file("request.json"),
    ready: file("parent-ready"),
    finish: file("finish"),
    effect: file("effect"),
    outcome: file("outcome.json"),
  };
  for (const dir of [fixture.a, fixture.b, fixture.temp, fixture.controllers]) {
    fs.mkdirSync(dir);
  }
  return fixture;
}

/** Start imports and real executor admission before a test owns its behavior deadline. */
function startParent(killProcessTree: boolean) {
  const fixture = setup();
  const abort = new AbortController();
  let parentPid: number | undefined;
  let dispatched = false;
  let expectedControllers = 0;
  let behaviorTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = runCommandWithTimeout(
    [process.execPath, "--input-type=module", "-e", parentScript(), "--", JSON.stringify(fixture)],
    {
      input: "",
      beforeInput: (pid) => {
        parentPid = pid;
      },
      signal: abort.signal,
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
    ready: (signal: AbortSignal) =>
      withinTest(waitForFixtureFile(fixture.ready, pending, "ready"), signal),
    run(
      script: string,
      { timeout = 10000, deadline = 15000, parallel = false, missing = false } = {},
    ) {
      if (dispatched) {
        throw new Error("Fixture command was already dispatched");
      }
      dispatched = true;
      // The missing executable has no controller; every Node command records its own receipt.
      expectedControllers = missing ? 0 : parallel ? 2 : 1;
      behaviorTimer = setTimeout(
        () => abort.abort(new Error("Fixture behavior deadline expired")),
        deadline,
      );
      const argv = missing
        ? [path.join(fixture.root, "missing-native")]
        : [process.execPath, "-e", controllerScript(fixture, script)];
      const command = { argv, timeout, parallel };
      fs.writeFileSync(`${fixture.request}.tmp`, JSON.stringify(command));
      fs.renameSync(`${fixture.request}.tmp`, fixture.request);
      return pending;
    },
    async cleanup() {
      clearBehaviorTimer();
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
        expect(isPidAlive(parentPid)).toBe(false);
      }
      const receipts = () =>
        fs.readdirSync(fixture.controllers).filter((file) => file.endsWith(".json"));
      // The real owner can settle a timeout or spawn failure before any controller starts.
      if (dispatched && !fs.existsSync(fixture.outcome)) {
        if (expectedControllers === 0) {
          throw new Error(`Native launch did not report settlement; retaining ${fixture.root}`);
        }
        await expect.poll(() => receipts().length, { timeout: 5000 }).toBe(expectedControllers);
      }
      for (const receipt of receipts()) {
        const native: { pid: number; gate: number } = readJson(
          path.join(fixture.controllers, receipt),
        );
        await waitForDead(native.pid, AbortSignal.timeout(NATIVE_CLEANUP_GUARD_MS));
        await waitForDead(native.gate, AbortSignal.timeout(NATIVE_CLEANUP_GUARD_MS));
        await expect
          .poll(() => isChildProcessTreeAlive({ pid: native.gate }), { timeout: 5000 })
          .toBe(false);
      }
      // Retire the private directory without releasing still-current signal leases.
    },
  };
}

function useParent(killProcessTree: boolean) {
  beforeEach(async ({ signal }) => {
    if (preparedParent) {
      throw new Error(`Previous fixture cleanup is unresolved: ${preparedParent.fixture.root}`);
    }
    preparedParent = startParent(killProcessTree);
    await preparedParent.ready(signal);
  }, DEFAULT_VITEST_TEST_TIMEOUT_MS);
  return () => {
    if (!preparedParent) {
      throw new Error("Missing prepared fixture parent");
    }
    return preparedParent;
  };
}

function leaseStore(fixture: ReturnType<typeof setup>) {
  return createManagedHandoffLeaseStore({
    databasePath: path.join(fixture.temp, "managed-update-handoffs.sqlite"),
    serviceManagerEnv: {},
  });
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const expectEffect = (fixture: ReturnType<typeof setup>) =>
  expect.poll(() => fs.existsSync(fixture.effect), { timeout: 5000 }).toBe(true);

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
        const { fixture } = prepared;
        const pending = prepared.run("setInterval(()=>{},10);", {
          timeout: 15000,
          deadline: 20000,
        });
        const parentPid = prepared.pid();
        let native: { pid: number; gate: number } | undefined;
        try {
          await expect.poll(() => fs.existsSync(fixture.started), { timeout: 10000 }).toBe(true);
          native = readJson(fixture.started);
          if (!native || !parentPid) {
            throw new Error("Missing live fixture process receipt");
          }
          process.kill(parentPid, "SIGKILL");
          await pending;
          if (loss === "gate") {
            process.kill(native.gate, "SIGKILL");
          }
          process.kill(native.pid, 0);
          const store = leaseStore(fixture);
          for (const root of [fixture.a, fixture.b]) {
            expect(store.acquire(root, randomUUID(), { kind: "update" }).kind).toBe("busy");
          }
          expect(fs.existsSync(fixture.effect)).toBe(false);
          fs.writeFileSync(fixture.finish, "");
          await expectEffect(fixture);
          // Release requires both the recorded gate and its native lineage to disappear.
          for (const root of [fixture.a, fixture.b]) {
            await expect
              .poll(
                () => {
                  const admitted = store.acquire(root, randomUUID(), { kind: "update" });
                  return admitted.kind === "acquired" && store.release(admitted.lease);
                },
                { timeout: 5000 },
              )
              .toBe(true);
          }
        } finally {
          fs.writeFileSync(fixture.finish, "");
          await pending;
          if (native) {
            await expectEffect(fixture);
          }
        }
      },
      30000,
    );
  });

  describe("native outcomes", () => {
    const parent = useParent(true);

    it.each([
      [
        "nonzero",
        'process.stdout.write("raw-out");process.stderr.write("raw-err");process.exitCode=7;',
        { code: 7, termination: "exit", stdout: "raw-out", stderr: "raw-err" },
      ],
      ["signal", 'process.kill(process.pid,"SIGTERM");', {}],
      ["timeout", "setInterval(()=>{},10);", { code: 124, termination: "timeout" }],
      ["missing binary", "", { code: 1, termination: "error", errorCode: "ENOENT" }],
    ] as const)(
      "preserves real native %s result or cleanup uncertainty through the bound gate",
      async (name, script, expected) => {
        const prepared = parent();
        const fixture = prepared.fixture;
        const result = await prepared.run(script, {
          timeout: name === "timeout" ? 1000 : 10000,
          missing: name === "missing binary",
        });
        if (name === "signal") {
          // A child-requested signal stays uncertain and must retain both roots.
          expect(result).toMatchObject({
            code: 1,
            stderr: expect.stringContaining(
              "Command cleanup could not confirm that owned work stopped",
            ),
          });
          expect(fs.existsSync(fixture.outcome)).toBe(false);
          const store = leaseStore(fixture);
          for (const root of [fixture.a, fixture.b]) {
            expect(store.read(root).kind).toBe("current");
          }
        } else {
          expect(fs.existsSync(fixture.outcome), result.stderr).toBe(true);
          expect(readJson(fixture.outcome)).toMatchObject(expected);
          expect(result.code, result.stderr).toBe(1);
        }
      },
      20000,
    );

    it("serializes real concurrent reads under one retained executor", async () => {
      const prepared = parent();
      const fixture = prepared.fixture;
      const settled = await prepared.run('setTimeout(()=>process.stdout.write("read"),30);', {
        parallel: true,
      });
      expect(settled.code, settled.stderr).toBe(0);
      expect(readJson(fixture.outcome)).toEqual([
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
