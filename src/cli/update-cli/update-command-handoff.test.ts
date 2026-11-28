import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import * as processIdentity from "@openclaw/proc-safe/identity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffWorker } from "../../../test/helpers/private-update-handoff-store.js";
import * as serviceMembership from "../../daemon/service-process-membership.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as ancestry from "../../infra/restart-stale-pids.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { triageTestRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { UpdatePreMutationError } from "./shared.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  formatUpdateAncestryBlockMessage,
  gatewayMaintenanceBlock,
  handoffUpdateFromGateway,
} from "./update-command-handoff.js";
import { createHandoffLifetimePreload } from "./update-command-handoff.test-support.js";
import { createUpdateCommandFailureResult } from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

const UPDATE_HANDOFF_IN_PROGRESS_EXIT_CODE = 75;

vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
}));

const tempDirs = createTrackedTempDirs();
beforeEach(async () => {
  const control = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-parent-control-"));
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

it
  .runIf(process.platform === "darwin")
  .each(["cancel", "cancel-output-first", "transfer"] as const)(
  "settles the initiating CLI's owned handoff lifetime: %s",
  async (mode) => {
    const root = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-lifetime-"));
    const callerPath = path.join(root, "caller.mjs");
    const preloadPath = path.join(root, "handoff-order.cjs");
    const tracePath = path.join(root, "trace.jsonl");
    const resultPath = path.join(root, "result.json");
    const managerPath = path.join(root, "manager-calls");
    const control = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-control-"));
    const uid = process.getuid?.();
    const leasePath = path.join(
      control,
      uid === undefined ? "openclaw" : `openclaw-${uid}`,
      "managed-update-handoffs.sqlite",
    );
    const readTrace = () => fs.readFile(tracePath, "utf8");
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
      createHandoffLifetimePreload({ callerPath, root, leasePath, tracePath, mode }),
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
        TMPDIR: control,
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
      using db = new DatabaseSync(leasePath, { readOnly: true });
      return db.prepare("SELECT owner FROM managed_update_handoffs WHERE install_root=?").get(root);
    };
    try {
      // Transfer releases the CLI before its detached helper finishes owning the lease.
      await expect
        .poll(
          async () => {
            await fs.readFile(resultPath, "utf8");
            return readTrace();
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
      const trace = (await readTrace())
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

it.runIf(process.platform === "darwin").each([
  { membership: "outside", ancestor: false, code: undefined },
  { membership: "absent", ancestor: false, code: "service-ancestry-unverified" },
  { membership: "inside", ancestor: false, code: "inside-gateway-service" },
  { membership: "unknown", ancestor: false, code: "service-membership-unverified" },
  { membership: "outside", ancestor: true, code: "inside-gateway-process-tree" },
] as const)(
  "uses native $membership containment with an unreadable login ancestor (gateway ancestor: $ancestor)",
  ({ membership, ancestor, code }) => {
    const gatewayPid = process.pid + 1_000_000;
    const identity = (pid: number, parentPid: number, startTimeMicros: number) => ({
      pid,
      parentPid,
      startTimeMicros,
      startTimeResolutionMicros: 1,
      exited: false,
    });
    vi.spyOn(processIdentity, "readProcessAncestry").mockReturnValue({
      chain: [
        identity(process.pid, ancestor ? gatewayPid : gatewayPid + 1, 2),
        ...(ancestor ? [identity(gatewayPid, gatewayPid + 1, 1)] : []),
      ],
      complete: false,
      stoppedBy: "unreadable-parent",
    });
    vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue(membership);
    const block = gatewayMaintenanceBlock(
      { ...callerService, runtime: { status: "running", pid: gatewayPid } },
      process.cwd(),
    );
    if (code === undefined) {
      expect(block).toBeUndefined();
    } else {
      expect(block?.failureFacts).toEqual([
        expect.objectContaining({ check: "managed-service-preflight", code }),
      ]);
    }
  },
);

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

it.runIf(process.platform === "linux" || process.platform === "darwin").each([
  { complete: true, containsParent: false },
  { complete: false, containsParent: false },
  { complete: false, containsParent: true },
])(
  "does not start an unverified handoff ($complete, parent: $containsParent)",
  async ({ complete, containsParent }) => {
    vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
      pids: new Set(containsParent ? [process.pid, process.ppid] : [process.pid]),
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

it.runIf(process.platform === "darwin").each([
  [
    "engine incompatibility",
    "Node 24.21.0 is unsupported; OpenClaw requires >=24.22.1 <25 || >=26.12.1.\nnpm can finish installing without its preinstall check.\nRe-run the installer.\nOn Windows, use the PowerShell installer.\nOr with nvm: nvm install 26 && nvm use 26.\nThen retry openclaw update.",
    "Node 24.21.0 is unsupported",
  ],
  [
    "oversized crash output",
    `${"discarded startup noise".repeat(500)}\nError: helper startup failed: EACCES token=fixture-private-token\nRetry after correcting file permissions.`,
    "helper startup failed: EACCES",
  ],
  ["missing installed recovery runtime", null, "installed runtime is unavailable"],
] as const)(
  "retains bounded startup diagnostics from the live CLI handoff: %s",
  async (kind, output, expected) => {
    const root = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-diagnostics-"));
    const control = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-control-"));
    const entrypoint = path.join(root, "dist", "index.mjs");
    const managerLog = path.join(control, "manager.log");
    const node = resolveTestNodeExecPath();
    await fs.mkdir(path.dirname(entrypoint));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(entrypoint, "throw new Error('unexpected updater');");
    await fs.writeFile(
      path.join(root, "launchctl"),
      `#!${node}\nimport fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(managerLog)}, "called\\n");\nprocess.exit(61);\n`,
      { mode: 0o755 },
    );
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
      pids: new Set([process.pid, process.ppid]),
      complete: true,
    });
    const worker = installPrivateUpdateHandoffWorker(control);
    if (output !== null) {
      const prepare = expectDefined(worker.getMockImplementation(), "private lease worker");
      worker.mockImplementation(async (options) => {
        const store = await prepare(options);
        const stage = store.stageRuntime.bind(store);
        store.stageRuntime = async (directory) => {
          const files = await stage(directory);
          await fs.writeFile(
            expectDefined(files[0], "staged handoff runtime"),
            `process.stderr.write(${JSON.stringify(output)}); process.exit(1);`,
          );
          return files;
        };
        return store;
      });
    }
    await withEnvAsync(
      {
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.fixture",
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_SERVICE_SUPERVISOR: undefined,
        TMPDIR: control,
        TMP: control,
        TEMP: control,
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      async () => {
        const env = { ...process.env };
        try {
          const { runId } = createUpdateRun({ trigger: "cli" }, { env });
          const run = { runId, env };
          const stopProgress = vi.fn();
          let failure: unknown;
          try {
            await handoffUpdateFromGateway({
              state: {
                ...callerService,
                env,
                runtime: { status: "running", pid: process.ppid },
              },
              root,
              mode: "npm",
              opts: { json: true, run },
              timeoutMs: 10_000,
              nodeRunner: node,
              stopProgress,
            });
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(UpdatePreMutationError);
          expect(failure).toMatchObject({ reason: "managed-service-handoff-failed" });
          expect(stopProgress).toHaveBeenCalledOnce();
          completeUpdateCommandRun(
            createUpdateCommandFailureResult({
              mode: "npm",
              root,
              durationMs: 0,
              failure: { cause: failure },
            }),
            run,
          );
          const recorded = expectDefined(getUpdateRun(runId, { env }), "recorded CLI failure");
          expect(recorded).toMatchObject({
            status: "failed",
            reason: "managed-service-handoff-failed",
          });
          const facts = recorded.steps.flatMap((step) => step.failureFacts ?? []);
          expect(facts.length).toBeGreaterThan(0);
          const diagnostics = JSON.stringify(facts);
          expect(diagnostics).toContain(expected);
          expect(diagnostics).not.toContain("fixture-private-token");
          expect(diagnostics).not.toContain("discarded startup noise");
          expect(facts.every((fact) => (fact.message?.length ?? 0) <= 200)).toBe(true);
          const report = await prepareUpdateFailureReport(recorded, { env });
          expect(report.body).toContain("Reason code: managed-service-handoff-failed");
          expect(report.body).toMatch(
            /managed update handoff (?:exited before signaling readiness|control input closed)/,
          );
          if (kind === "oversized crash output") {
            expect(report.body).toContain("EACCES");
          }
          expect(report.body).not.toContain("fixture-private-token");
          expect(report.body).not.toContain("discarded startup noise");
          expect(report.body).not.toContain(root);
          expect(await fs.readFile(managerLog, "utf8").catch(() => "")).toBe("");
          expect(await fs.readFile(entrypoint, "utf8")).toBe(
            "throw new Error('unexpected updater');",
          );
        } finally {
          await closeStateDatabaseForTest();
        }
      },
    );
  },
);
