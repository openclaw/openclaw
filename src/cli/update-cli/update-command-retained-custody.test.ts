import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const url = (key: keyof typeof updateExecutorNativeEntrypoints) =>
  resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints[key]).href;

// The real direct owner, native authority/exec path and lease process probes use
// one compiled graph. Only secure-temp location is redirected into this fixture.
function parentScript() {
  return `
  import fs from "node:fs";
  import { registerSealedRuntime } from ${JSON.stringify(url("sealedRuntime"))};
  import { withUpdateCommandExecutor } from ${JSON.stringify(url("executor"))};
  import { withRetainedUpdateServiceAuthority } from ${JSON.stringify(url("retainedService"))};
  import { execFileUtf8 } from ${JSON.stringify(url("nativeExec"))};
  let input=""; for await (const chunk of process.stdin) input+=chunk;
  const { a,b,temp,argv,timeout,outcome,parallel }=JSON.parse(input);
  registerSealedRuntime({json5:null,resolveSecureTempRoot:()=>temp});
  const run={runId: "native-parent-"+process.pid};
  try {
    await withUpdateCommandExecutor(run.runId,async executor=>{
      run.executorFence=await executor.enter(b,{serviceRoot:a});
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
  const a = path.join(root, "A");
  const b = path.join(root, "B");
  const temp = path.join(root, "control");
  for (const dir of [a, b, temp]) {
    fs.mkdirSync(dir);
  }
  return {
    root,
    a,
    b,
    temp,
    started: path.join(root, "started.json"),
    finish: path.join(root, "finish"),
    effect: path.join(root, "effect"),
    outcome: path.join(root, "outcome.json"),
  };
}

describe.skipIf(process.platform === "win32")("POSIX bound native control", () => {
  it.each(["parent", "gate"] as const)(
    "retains both roots after %s loss while its real native controller survives",
    async (loss) => {
      const fixture = setup();
      const controller = `
      const fs=require("node:fs");
      fs.writeFileSync(${JSON.stringify(fixture.started)},JSON.stringify({pid:process.pid,gate:process.ppid}));
      const timer=setInterval(()=>{
        if(fs.existsSync(${JSON.stringify(fixture.finish)})){
          fs.writeFileSync(${JSON.stringify(fixture.effect)},"finished");
          clearInterval(timer);
        }
      },10);
    `;
      let parentPid: number | undefined;
      const pending = runCommandWithTimeout(
        [process.execPath, "--input-type=module", "-e", parentScript()],
        {
          input: JSON.stringify({
            ...fixture,
            argv: [process.execPath, "-e", controller],
            timeout: 15000,
          }),
          beforeInput: (pid) => {
            parentPid = pid;
          },
          timeoutMs: 20000,
          // Deliberately lose only this fixture parent. The production native
          // adapter must retain its own independently owned controller group.
          killProcessTree: false,
        },
      );
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

  it.each([
    {
      name: "nonzero",
      script: 'process.stdout.write("raw-out");process.stderr.write("raw-err");process.exitCode=7;',
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
    "preserves real native $name result through the bound gate",
    async ({ name, script, expected }) => {
      const fixture = setup();
      const result = await runCommandWithTimeout(
        [process.execPath, "--input-type=module", "-e", parentScript()],
        {
          input: JSON.stringify({
            ...fixture,
            argv:
              name === "missing binary"
                ? [path.join(fixture.root, "missing-native")]
                : [process.execPath, "-e", script],
            timeout: name === "timeout" ? 1000 : 10000,
          }),
          beforeInput: () => undefined,
          timeoutMs: 15000,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
        },
      );
      expect(fs.existsSync(fixture.outcome), result.stderr).toBe(true);
      expect(JSON.parse(fs.readFileSync(fixture.outcome, "utf8"))).toMatchObject(expected);
      expect(result.code, result.stderr).toBe(name === "healthy" ? 0 : 1);
    },
    20000,
  );
});

it.skipIf(process.platform === "win32")(
  "serializes real concurrent reads under one retained executor",
  async () => {
    const fixture = setup();
    const settled = await runCommandWithTimeout(
      [process.execPath, "--input-type=module", "-e", parentScript()],
      {
        input: JSON.stringify({
          ...fixture,
          parallel: true,
          timeout: 10000,
          argv: [process.execPath, "-e", 'setTimeout(()=>process.stdout.write("read"),30);'],
        }),
        beforeInput: () => undefined,
        timeoutMs: 15000,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
      },
    );
    expect(settled.code, settled.stderr).toBe(0);
    const results = JSON.parse(fs.readFileSync(fixture.outcome, "utf8"));
    expect(results).toHaveLength(2);
    expect(results).toEqual([
      expect.objectContaining({ code: 0, stdout: "read" }),
      expect.objectContaining({ code: 0, stdout: "read" }),
    ]);
  },
);

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
    async () => {
      calls += 1;
      throw Object.assign(new Error("fixture native refusal"), { code: "EACCES" });
    },
  );
});
