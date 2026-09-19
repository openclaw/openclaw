import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

afterEach(() => vi.restoreAllMocks());
const entry = (sourceWorkerName: string, distWorkerPath: string) =>
  resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName,
    distWorkerPath,
  });
const executor = entry("update-command-executor", "cli/update-cli/update-command-executor.js");
const caller = entry("update-command-config", "cli/update-cli/update-command-config.js");
const config = entry("../../config/config", "config/config.js");
const sourceArgs = executor.pathname.endsWith(".ts")
  ? ["--import", path.resolve("scripts/tsx.mjs")]
  : [];

it.each(["healthy", "original-owner-replaced", "include-parent-replaced"] as const)(
  "delegated candidate include effect retains original owner and directory: %s",
  async (fault) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const control = state.path("control");
      const root = state.path("install");
      fs.mkdirSync(control);
      fs.mkdirSync(root);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await state.writeConfig({
        plugins: { enabled: false },
        update: { $include: "./fragments/channel.json" },
      });
      const fragmentDir = state.statePath("fragments");
      fs.mkdirSync(fragmentDir);
      const fragment = path.join(fragmentDir, "channel.json");
      const original = '{"channel":"stable"}\n';
      fs.writeFileSync(fragment, original);
      const rootRaw = fs.readFileSync(state.configPath, "utf8");
      const proceed = state.path("proceed");
      const ready = createDeferred<{
        pid: number;
        parentPid: number;
        parentOwner: string;
        candidate: string;
      }>();
      let stdout = "";
      const receiver = `
        import fs from 'node:fs';
        import fsp from 'node:fs/promises';
        import {setTimeout} from 'node:timers/promises';
        import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(executor.href)};
        import {persistRequestedUpdateChannel} from ${JSON.stringify(caller.href)};
        import {readConfigFileSnapshot} from ${JSON.stringify(config.href)};
        const {grant,proceed}=JSON.parse(fs.readFileSync(0,'utf8'));
        const open=fsp.open;
        let announced=false;
        fsp.open=async(...args)=>{
          const handle=await open(...args);
          if(!announced && String(args[0]).includes('openclaw-config-backup')) {
            announced=true;
            process.stdout.write(JSON.stringify({ready:true,pid:process.pid,parentPid:grant.parent.executor.pid,parentOwner:grant.parent.owner,candidate:${JSON.stringify(caller.href)}})+'\\n');
            while(!fs.existsSync(proceed)) await setTimeout(10);
          }
          return handle;
        };
        try {
          await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async fence=>{
            const snapshot=await readConfigFileSnapshot({skipPluginValidation:true,observe:false});
            const result=await persistRequestedUpdateChannel({configSnapshot:snapshot,requestedChannel:'beta',assertCurrent:fence.assertCurrent});
            process.stdout.write(JSON.stringify({result:'published',channel:result.config.update.channel,pid:process.pid})+'\\n');
          });
        } catch(error) {
          process.stdout.write(JSON.stringify({result:'refused',error:String(error),pid:process.pid})+'\\n');
          process.exitCode=1;
        }
      `;
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      let boundPid: number | undefined;
      const work = withUpdateCommandExecutor(run.runId, async (owner) => {
        const fence = await owner.enter(root);
        const pending = withUpdateCommandExecutorChild(fence, root, (grant, bindChild) =>
          runUtf8CommandWithTimeout(
            [process.execPath, ...sourceArgs, "--input-type=module", "-e", receiver],
            {
              input: JSON.stringify({ grant, proceed }),
              env: state.env,
              beforeInput: (pid) => {
                boundPid = pid;
                bindChild(pid);
              },
              timeoutMs: 30_000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              onOutputChunk: (chunk) => {
                stdout += String(chunk);
                const line = stdout.split("\n").find((value) => value.startsWith('{"ready":true'));
                if (line) {
                  ready.resolve(JSON.parse(line));
                }
              },
            },
          ),
        );
        try {
          const binding = await Promise.race([
            ready.promise,
            pending.then((result) => {
              throw new Error(result.stderr || stdout || "child exited before include preparation");
            }),
          ]);
          expect(binding.pid).toBe(boundPid);
          expect(binding.pid).not.toBe(process.pid);
          expect(binding.parentPid).toBe(process.pid);
          expect(binding.candidate).toBe(caller.href);
          expect(binding.parentOwner.length).toBeGreaterThan(0);
          if (fault === "original-owner-replaced") {
            const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
            try {
              db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
                "replacement",
                root,
              );
            } finally {
              db.close();
            }
          }
          if (fault === "include-parent-replaced") {
            fs.renameSync(fragmentDir, `${fragmentDir}-old`);
            fs.mkdirSync(fragmentDir);
            fs.writeFileSync(fragment, original);
          }
        } finally {
          fs.writeFileSync(proceed, "go");
        }
        return await pending;
      });
      const outcome = await work.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      console.log(
        JSON.stringify({ fault, boundPid, parentPid: process.pid, candidate: caller.href, stdout }),
      );
      if (fault === "healthy") {
        expect("value" in outcome && outcome.value.code === 0, stdout).toBe(true);
        expect(JSON.parse(fs.readFileSync(fragment, "utf8")).channel).toBe("beta");
        expect(fs.readFileSync(`${fragment}.bak`, "utf8")).toBe(original);
      } else {
        expect(stdout).toContain('"result":"refused"');
        expect(fs.readFileSync(fragment, "utf8")).toBe(original);
        expect(fs.existsSync(`${fragment}.bak`)).toBe(false);
        if (fault === "include-parent-replaced") {
          expect(fs.readFileSync(path.join(`${fragmentDir}-old`, "channel.json"), "utf8")).toBe(
            original,
          );
        }
      }
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(rootRaw);
    });
  },
);
