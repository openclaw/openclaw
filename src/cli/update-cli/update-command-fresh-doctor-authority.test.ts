import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { adoptUpdateRun, createUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";
import { formatUpdateFinalizationError } from "./update-command-result.js";

const testFixture = createFixtureLifetime();
afterEach(async () => {
  try {
    await testFixture.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

const source = (name: string) =>
  resolveRuntimeWorkerUrl({
    currentModuleUrl: updateExecutorNativeEntrypoints.executor.currentModuleUrl,
    sourceWorkerName: name,
    distWorkerPath: `legacy-finalizer/src/${name.replace(/^\.\.\//, "").replace(/^\.\.\//, "")}.js`,
  });
const doctor = source("../../commands/doctor");
const worker = source("../../infra/update-migrated-finalize.worker");
const temporary = source("../../infra/tmp-openclaw-dir");
const packageRoot = source("../../infra/openclaw-root");
const runtime = source("../../runtime");
const database = source("../../state/openclaw-state-db");
const doctorResult = source("../../infra/update-doctor-result");
const readText = (file: string) => fs.readFileSync(file, "utf8");
const readConfig = (file: string) => JSON.parse(readText(file));

it.for(["healthy", "original-owner-replaced"] as const)(
  "fresh Doctor retains update authority at final config I/O: %s",
  { timeout: 60_000 },
  async (fault, { signal }) => {
    const stateWork = withOpenClawTestState(
      {
        scenario: "minimal",
        env: {
          OPENCLAW_PROFILE: undefined,
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
        for (const method of ["log", "error"] as const) {
          vi.spyOn(defaultRuntime, method).mockImplementation((text) => {
            diagnostics += String(text);
          });
        }
        await state.writeConfig({
          plugins: { enabled: false },
          agents: { defaults: { workspace: state.workspaceDir } },
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "doctor-authority-test-token" },
            nodes: {
              commands: {
                deny: (
                  "camera.snap camera.clip screen.record computer.act mobile.ui.observe mobile.ui.act " +
                  "contacts.add calendar.add reminders.add sms.send sms.search health.summary"
                ).split(" "),
              },
            },
          },
        });
        const original = readText(state.configPath);
        const readyPath = state.path("ready");
        const proceed = state.path("proceed");
        // Only root/temp discovery is mocked; Doctor, its grant and config I/O remain real.
        const barrier = `
        import fs from "node:fs";
        import fsp from "node:fs/promises";
        import {setTimeout} from "node:timers/promises";
        import {registerHooks} from "node:module";
        ${fixtureReceiptClientSource(receipts.endpoint)}
        ${doctor.pathname.endsWith(".ts") ? `process.chdir(${JSON.stringify(path.resolve("."))});` : ""}
        const overrides=new Map([
          [${JSON.stringify(temporary.href)}, ${JSON.stringify(`export function resolvePreferredOpenClawTmpDir(){return ${JSON.stringify(control)};}`)}],
          [${JSON.stringify(packageRoot.href)}, ${JSON.stringify(`export async function resolveOpenClawPackageRoot(){return ${JSON.stringify(root)};}`)}],
        ]);
        registerHooks({load(url,ctx,next){
          const replacement=overrides.get(url);
          return replacement===undefined?next(url,ctx):{format:"module",source:'export * from '+JSON.stringify(url+'?fixture-original')+';\\n'+replacement,shortCircuit:true};
        }});
        ${doctor.pathname.endsWith(".ts") ? `process.env.TSX_TSCONFIG_PATH=${JSON.stringify(path.resolve("tsconfig.json"))}; await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/tsx.mjs")).href)});` : ""}
        const {getUpdateDoctorConfigWriteAuthority}=await import(${JSON.stringify(doctorResult.href)});
        const open=fsp.open;
        let reached=false;
        fsp.open=async(...args)=>{
          const handle=await open(...args);
          if(!reached && String(args[0]).includes("openclaw-config-backup")) {
            reached=true;
            fs.writeFileSync(${JSON.stringify(`${readyPath}.tmp`)},JSON.stringify({pid:process.pid,authority:!!getUpdateDoctorConfigWriteAuthority(process.env.OPENCLAW_CONFIG_PATH)}));
            fs.renameSync(${JSON.stringify(`${readyPath}.tmp`)},${JSON.stringify(readyPath)});
            sendReceipt(${JSON.stringify(readyPath)},"config-backup");
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
        const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
        adoptUpdateRun(runId, { env: state.env });
        const pending = withUpdateCommandExecutor(runId, async (executor) => {
          const fence = await executor.enter(root);
          await runUpdateFinalizationDoctorInFreshProcess({
            phase: "post-plugin",
            doctorConfigWrites: true,
            root,
            entryPath,
            opts: { run: { runId, env: state.env, executorFence: fence } },
            runId,
            yes: true,
            json: true,
            workspaceSuggestions: false,
            nodeRunner: resolveTestNodeExecPath(),
            timeoutMs: 45_000,
            assertCurrent: fence.assertCurrent,
          });
          fence.assertCurrent();
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({
            ok: false as const,
            error: formatUpdateFinalizationError(error),
          }),
        );
        try {
          // The atomic record also covers settlement beating delivery on the receipt socket.
          await withinTest(
            Promise.race([
              receipts.waitFor(readyPath, "config-backup"),
              pending.then((outcome) => {
                if (!fs.existsSync(readyPath)) {
                  throw new Error(
                    `Doctor exited before config I/O: ${JSON.stringify(outcome)} ${diagnostics}`,
                  );
                }
              }),
            ]),
            signal,
          );
          const binding: { pid: number; authority: boolean } = readConfig(readyPath);
          expect(binding.pid).not.toBe(process.pid);
          expect(readText(state.configPath)).toBe(original);
          if (fault === "original-owner-replaced") {
            using db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
            expect(
              db
                .prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?")
                .run("replacement", root).changes,
            ).toBe(1);
          }
        } finally {
          fs.writeFileSync(proceed, "go");
          await pending;
        }
        const outcome = await pending;
        expect(outcome.ok, diagnostics).toBe(fault === "healthy");
        if (fault === "healthy") {
          expect(readConfig(state.configPath).gateway.nodes?.commands).toBeUndefined();
          expect(readText(`${state.configPath}.bak`)).toBe(original);
        } else {
          expect(readText(state.configPath)).toBe(original);
          expect(fs.existsSync(`${state.configPath}.bak`)).toBe(false);
        }
      },
    );
    await testFixture.track(stateWork);
  },
);
