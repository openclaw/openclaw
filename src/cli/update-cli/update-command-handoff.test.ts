import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as serviceMembership from "../../daemon/service-process-membership.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as ancestry from "../../infra/restart-stale-pids.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { triageTestRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  formatUpdateAncestryBlockMessage,
  gatewayMaintenanceBlock,
  handoffUpdateFromGateway,
} from "./update-command-handoff.js";

const UPDATE_HANDOFF_IN_PROGRESS_EXIT_CODE = 75;

const tempDirs = createTrackedTempDirs();
beforeEach(async () => {
  const control = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-parent-control-"));
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

it.runIf(process.platform === "darwin").each(["cancel", "cancel-output-first", "transfer"])(
  "settles the initiating CLI's owned handoff lifetime: %s",
  async (mode) => {
    const root = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-lifetime-"));
    const callerPath = path.join(root, "caller.mjs");
    const preloadPath = path.join(root, "handoff-order.cjs");
    const tracePath = path.join(root, "trace.jsonl");
    const resultPath = path.join(root, "result.json");
    const managerPath = path.join(root, "manager-calls");
    const control = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-control-"));
    const leasePath = path.join(control, "managed-update-handoffs.sqlite");
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0", type: "module" }),
    );
    await fs.writeFile(path.join(root, "dist/index.mjs"), "throw new Error('unexpected updater');");
    // The task-owned manager rejects every service command; host launchd is never invoked.
    await fs.writeFile(
      path.join(root, "launchctl"),
      `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(managerPath)}, 'called\\n');process.exit(61);`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      preloadPath,
      `
const fs=require('node:fs');
const record=(event,data={})=>fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({event,...data})+'\\n');
if(process.argv[1]===${JSON.stringify(callerPath)} && ${mode !== "transfer"}) {
  const sqlite=require('node:sqlite'), Original=sqlite.DatabaseSync;
  sqlite.DatabaseSync=new Proxy(Original,{construct(target,args,newTarget) {
    if(String(args[0])===${JSON.stringify(path.join(root, "state/openclaw.sqlite"))}) {
      const db=new Original(${JSON.stringify(leasePath)},{readOnly:true});
      const lease=db.prepare('SELECT owner FROM managed_update_handoffs WHERE install_root=?').get(${JSON.stringify(root)});
      db.close();record('publication-denied',{ready:!!lease});
      throw Object.assign(new Error('fixture publication denied'),{code:'SQLITE_CANTOPEN'});
    }
    return Reflect.construct(target,args,newTarget);
  }});
  require('node:module').syncBuiltinESMExports();
} else if(process.argv[1]?.endsWith('/handoff.cjs')) {
  const params=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if(params.updateLeaseKey===${JSON.stringify(root)}) {
    if(params.updateLeaseDatabasePath!==${JSON.stringify(leasePath)} || params.updateLeaseDatabaseIdentity?.databasePath!==${JSON.stringify(leasePath)}) {
      throw new Error("Fixture handoff escaped its private lease database");
    }
    if(${mode === "cancel-output-first"}) {
      // Close only helper output before native exit; the initiating CLI has no keepalive.
      process.once('beforeExit',()=>{record('helper-output-closed');process.stdout.end();setTimeout(()=>{},100);});
    }
    process.once('exit',()=>record('helper-exit'));
  }
}`,
    );
    await fs.writeFile(
      callerPath,
      `
import fs from 'node:fs';
import * as json5 from ${JSON.stringify(import.meta.resolve("json5"))};
import {registerSealedRuntime} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.sealedRuntime).href)};
registerSealedRuntime({json5,resolveSecureTempRoot:()=>${JSON.stringify(control)}});
const {handoffUpdateFromGateway}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateHandoff).href)});
try {
  const transferred=await handoffUpdateFromGateway({state:{env:process.env,runtime:{status:'running',pid:process.ppid}},root:${JSON.stringify(root)},mode:'npm',opts:{json:true},timeoutMs:10000,nodeRunner:process.execPath,stopProgress:()=>{}});
  fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({event:'caller-transferred',transferred})+'\\n');
} catch(error) {
  fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({event:'caller-error',message:String(error)})+'\\n');
  process.stdout.write(JSON.stringify({code:error.code})+'\\n');process.exitCode=23;
}`,
    );
    const gatewayPath = path.join(root, "gateway.cjs");
    await fs.writeFile(
      gatewayPath,
      `
const fs=require('node:fs'),{spawn}=require('node:child_process');process.stdin.resume();
const child=spawn(process.execPath,[${JSON.stringify(callerPath)}],{env:process.env,stdio:['pipe','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
child.once('close',(code,signal)=>{fs.writeFileSync(${JSON.stringify(resultPath + ".tmp")},JSON.stringify({code,signal,stdout,stderr}));fs.renameSync(${JSON.stringify(resultPath + ".tmp")},${JSON.stringify(resultPath)});child.stdin.destroy();});
process.stdin.once('end',()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');process.stdin.destroy();});`,
    );
    const gateway = spawn(process.execPath, [gatewayPath], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.handoff-test.${process.pid}`,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
        NODE_OPTIONS: `--require=${JSON.stringify(preloadPath)}`,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const closed = new Promise<void>((resolve) => {
      gateway.once("close", () => resolve());
    });
    const readLease = () => {
      const db = new DatabaseSync(leasePath, { readOnly: true });
      try {
        return db
          .prepare("SELECT owner FROM managed_update_handoffs WHERE install_root=?")
          .get(root);
      } finally {
        db.close();
      }
    };
    try {
      // Transfer releases the CLI before its detached helper finishes owning the lease.
      await expect
        .poll(
          async () => {
            await fs.readFile(resultPath, "utf8");
            return fs.readFile(tracePath, "utf8");
          },
          { timeout: 20_000 },
        )
        .toContain('"event":"helper-exit"');
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      expect(readLease()).toBeUndefined();
      expect(gateway.exitCode).toBeNull();
      expect(result.code, result.stderr).toBe(
        mode === "transfer" ? UPDATE_HANDOFF_IN_PROGRESS_EXIT_CODE : 23,
      );
      const trace = (await fs.readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (mode === "transfer") {
        expect(trace[0]).toEqual({ event: "caller-transferred", transferred: true });
      } else {
        expect(JSON.parse(result.stdout)).toEqual({ code: "SQLITE_CANTOPEN" });
        expect(await fs.readFile(managerPath, "utf8").catch(() => "")).toBe("");
        expect(trace[0]).toEqual({ event: "publication-denied", ready: true });
        if (mode === "cancel-output-first") {
          expect(trace.map((row) => row.event)).toEqual([
            "publication-denied",
            "helper-output-closed",
            "helper-exit",
            "caller-error",
          ]);
        }
      }
    } finally {
      gateway.stdin.end();
      await closed;
      await expect.poll(() => fs.readFile(tracePath, "utf8")).toContain('"event":"helper-exit"');
      expect(readLease()).toBeUndefined();
    }
  },
);

const callerService = {
  installed: true,
  loadState: { status: "loaded" },
  running: true,
  env: {},
  command: null,
  runtime: { status: "running", pid: process.pid },
} satisfies GatewayServiceState;

describe("gatewayMaintenanceBlock", () => {
  it("never advises stopping the gateway service or running update from the caller", () => {
    const message = gatewayMaintenanceBlock(callerService, process.cwd())?.message;
    expect(message).toContain("inside the gateway process tree");
    expect(message).toContain("from a shell outside the gateway service");
    expect(message).not.toContain("stop the gateway service first");
    expect(message).not.toContain("openclaw update");
  });

  it("allows a caller with verified external ancestry and native membership", () => {
    vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue("outside");
    vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
      pids: new Set([process.pid, 1]),
      complete: true,
    });
    expect(
      gatewayMaintenanceBlock(
        { ...callerService, runtime: { status: "running", pid: 2 } },
        process.cwd(),
      ),
    ).toBeUndefined();
  });
});

it.runIf(process.platform === "linux" || process.platform === "darwin").each([true, false])(
  "does not start a handoff from inherited markers without a verified ancestor (complete: %s)",
  async (complete) => {
    vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
      pids: new Set([process.pid]),
      complete,
    });
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_GATEWAY_SERVICE_PID: String(process.ppid),
        INVOCATION_ID: "fixture-inherited",
      },
      async () => {
        await expect(
          handoffUpdateFromGateway({
            state: { ...callerService, runtime: { status: "running", pid: process.ppid } },
            root: process.cwd(),
            mode: "npm",
            opts: {},
            timeoutMs: 1000,
            stopProgress: () => {
              throw new Error("An unverified caller must not start handoff preparation");
            },
          }),
        ).resolves.toBe(false);
      },
    );
  },
);

describe("formatUpdateAncestryBlockMessage", () => {
  it("adds the chat handoff advice only to ancestry blocks", () => {
    const blockMessage = gatewayMaintenanceBlock(callerService, process.cwd())?.message ?? "";
    const updateMessage = formatUpdateAncestryBlockMessage(blockMessage);
    expect(updateMessage).toContain("/update");
    expect(updateMessage).not.toContain("shell outside");
    expect(updateMessage).not.toContain("terminal");
    expect(formatUpdateAncestryBlockMessage("service inspection unavailable")).toBe(
      "service inspection unavailable",
    );
  });
});
