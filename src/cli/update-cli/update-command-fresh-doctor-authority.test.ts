import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { waitForFixtureFile } from "../../../test/helpers/process-wait.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";
import { formatUpdateFinalizationError } from "./update-command-result.js";

afterEach(() => vi.restoreAllMocks());

const source = (name: string, distWorkerPath: string) =>
  resolveRuntimeWorkerUrl({
    currentModuleUrl: updateExecutorNativeEntrypoints.executor.currentModuleUrl,
    sourceWorkerName: name,
    distWorkerPath: `legacy-finalizer/src/${distWorkerPath}`,
  });
const doctor = source("../../commands/doctor", "commands/doctor.js");
const worker = source(
  "../../infra/update-migrated-finalize.worker",
  "infra/update-migrated-finalize.worker.js",
);
const temporary = source("../../infra/tmp-openclaw-dir", "infra/tmp-openclaw-dir.js");
const packageRoot = source("../../infra/openclaw-root", "infra/openclaw-root.js");
const runtime = source("../../runtime", "runtime.js");
const database = source("../../state/openclaw-state-db", "state/openclaw-state-db.js");
const doctorResult = source("../../infra/update-doctor-result", "infra/update-doctor-result.js");

it.each(["healthy", "original-owner-replaced"] as const)(
  "fresh Doctor retains update authority at final config I/O: %s",
  async (fault) => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: {
          OPENCLAW_PROFILE: undefined,
          // This config-write fixture installs no plugins; do not discover the host catalog.
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        const root = state.path("install");
        const control = state.path("control");
        fs.mkdirSync(control);
        fs.mkdirSync(path.join(root, "dist", "infra"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", type: "module", version: "2026.9.6" }),
        );
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        let diagnostics = "";
        vi.spyOn(defaultRuntime, "log").mockImplementation((text) => {
          diagnostics += String(text);
        });
        vi.spyOn(defaultRuntime, "error").mockImplementation((text) => {
          diagnostics += String(text);
        });
        await state.writeConfig({
          plugins: { enabled: false },
          agents: { defaults: { workspace: state.workspaceDir } },
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "doctor-authority-test-token" },
            nodes: {
              commands: {
                deny: [
                  "camera.snap",
                  "camera.clip",
                  "screen.record",
                  "computer.act",
                  "mobile.ui.observe",
                  "mobile.ui.act",
                  "contacts.add",
                  "calendar.add",
                  "reminders.add",
                  "sms.send",
                  "sms.search",
                  "health.summary",
                ],
              },
            },
          },
        });
        const original = fs.readFileSync(state.configPath, "utf8");
        const readyPath = state.path("ready");
        const progressPath = state.path("doctor-progress");
        const outputPath = state.path("doctor-output");
        const proceed = state.path("proceed");
        // Root/temp discovery stays isolated; the worker, full Doctor flow, grant,
        // input-hash check, config writer and filesystem effects remain real.
        const barrier = `
        import fs from "node:fs";
        import fsp from "node:fs/promises";
        import {setTimeout} from "node:timers/promises";
        import {registerHooks} from "node:module";
        ${doctor.pathname.endsWith(".ts") ? `process.chdir(${JSON.stringify(path.resolve("."))});` : ""}
        const mark=(stage)=>fs.appendFileSync(${JSON.stringify(progressPath)},JSON.stringify({stage,at:Date.now(),pid:process.pid})+"\\n");
        mark("fixture-entry");
        for(const name of ['stdout','stderr']) {
          const stream=process[name];
          const write=stream.write.bind(stream);
          stream.write=(chunk,...args)=>{
            fs.appendFileSync(${JSON.stringify(outputPath)},String(chunk));
            return write(chunk,...args);
          };
        }
        process.on('exit',(code)=>mark({event:'exit',code}));
        const overrides=new Map([
          [${JSON.stringify(temporary.href)}, ${JSON.stringify(`export function resolvePreferredOpenClawTmpDir(){return ${JSON.stringify(control)};}`)}],
          [${JSON.stringify(packageRoot.href)}, ${JSON.stringify(`export async function resolveOpenClawPackageRoot(){return ${JSON.stringify(root)};}`)}],
        ]);
        registerHooks({load(url,ctx,next){
          if(/\\/(?:update-migrated-finalize\\.worker|doctor-health)\\.(?:ts|js)$/.test(url)) mark(url);
          const replacement=overrides.get(url);
          return replacement===undefined?next(url,ctx):{format:"module",source:'export * from '+JSON.stringify(url+'?fixture-original')+';\\n'+replacement,shortCircuit:true};
        }});
        ${doctor.pathname.endsWith(".ts") ? `process.env.TSX_TSCONFIG_PATH=${JSON.stringify(path.resolve("tsconfig.json"))}; await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/tsx.mjs")).href)});` : ""}
        const {getUpdateDoctorConfigWriteAuthority}=await import(${JSON.stringify(doctorResult.href)});
        mark("capture-loaded");
        const open=fsp.open;
        let reached=false;
        fsp.open=async(...args)=>{
          const handle=await open(...args);
          if(!reached && String(args[0]).includes("openclaw-config-backup")) {
            reached=true;
            fs.writeFileSync(${JSON.stringify(`${readyPath}.tmp`)},JSON.stringify({pid:process.pid,authority:!!getUpdateDoctorConfigWriteAuthority(process.env.OPENCLAW_CONFIG_PATH)}));
            fs.renameSync(${JSON.stringify(`${readyPath}.tmp`)},${JSON.stringify(readyPath)});
            while(!fs.existsSync(${JSON.stringify(proceed)})) await setTimeout(10);
          }
          return handle;
        };
      `;
        const entryPath = path.join(root, "dist", "index.js");
        fs.writeFileSync(
          entryPath,
          `${barrier}
        const {doctorCommand}=await import(${JSON.stringify(doctor.href)});
        const {defaultRuntime}=await import(${JSON.stringify(runtime.href)});
        try {
          await doctorCommand({...defaultRuntime,exit:(code)=>{process.exitCode=code;}},
            {repair:true,nonInteractive:true,yes:true,workspaceSuggestions:false});
        } finally {
          const {closeOpenClawStateDatabaseAsync}=await import(${JSON.stringify(database.href)});
          await closeOpenClawStateDatabaseAsync();
        }
      `,
        );
        fs.writeFileSync(
          path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
          `${barrier}\nawait import(${JSON.stringify(worker.href)});`,
        );
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const opts: UpdateCommandOptions = { run: { runId: run.runId, env: state.env } };
        const pending = withUpdateCommandExecutor(run.runId, async (executor) => {
          const fence = await executor.enter(root);
          opts.run!.executorFence = fence;
          const params = {
            phase: "post-plugin" as const,
            root,
            entryPath,
            opts,
            runId: run.runId,
            yes: true,
            json: true,
            workspaceSuggestions: false,
            nodeRunner: process.execPath,
            timeoutMs: 45_000,
            assertCurrent: fence.assertCurrent,
          };
          await runUpdateFinalizationDoctorInFreshProcess(params);
          fence.assertCurrent();
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error: formatUpdateFinalizationError(error) }),
        );
        let binding: { pid: number; authority: boolean };
        try {
          binding = await Promise.race([
            waitForFixtureFile(readyPath, pending).then(() => {
              const receipt: { pid: number; authority: boolean } = JSON.parse(
                fs.readFileSync(readyPath, "utf8"),
              );
              return receipt;
            }),
            pending.then((outcome) => {
              throw new Error(
                `Doctor exited before config I/O: ${JSON.stringify(outcome)} ${diagnostics} ${fs.existsSync(progressPath) ? fs.readFileSync(progressPath, "utf8") : "no child entry"}`,
              );
            }),
          ]);
          expect(binding.pid).not.toBe(process.pid);
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(original);
          if (fault === "original-owner-replaced") {
            const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
            try {
              expect(
                db
                  .prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?")
                  .run("replacement", root).changes,
              ).toBe(1);
            } finally {
              db.close();
            }
          }
        } finally {
          fs.writeFileSync(proceed, "go");
          await pending;
        }
        const outcome = await pending;
        console.log(
          JSON.stringify({
            fault,
            ...binding,
            outcome,
            ...(!outcome.ok && fault === "healthy"
              ? {
                  progress: fs.readFileSync(progressPath, "utf8"),
                  childOutput: fs.existsSync(outputPath)
                    ? fs.readFileSync(outputPath, "utf8").slice(-5000)
                    : "",
                }
              : {}),
            configChanged: fs.readFileSync(state.configPath, "utf8") !== original,
          }),
        );
        if (fault === "healthy") {
          expect(outcome.ok, diagnostics).toBe(true);
          expect(
            JSON.parse(fs.readFileSync(state.configPath, "utf8")).gateway.nodes?.commands,
          ).toBeUndefined();
          expect(fs.readFileSync(`${state.configPath}.bak`, "utf8")).toBe(original);
        } else {
          expect(outcome.ok, diagnostics).toBe(false);
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(original);
          expect(fs.existsSync(`${state.configPath}.bak`)).toBe(false);
        }
      },
    );
  },
  60_000,
);
