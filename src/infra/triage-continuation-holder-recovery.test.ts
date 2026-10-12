import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { forceKillChildProcessTree } from "../process/child-process-tree.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  expectReleasedTriage,
  expectTriageCompleted,
  expectTriageDenial,
} from "./triage-continuation-recovery.test-support.js";
import {
  triageLeaseFixtureLifetime,
  triageRuntimePreloadEnv,
  useTriageLeaseDatabaseFixture,
} from "./triage-lease-fixture.test-support.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";

useTriageLeaseDatabaseFixture();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function foreground(root: string, phase: string) {
  const child = spawn(process.execPath, [path.join(root, "foreground.mjs"), phase], {
    env: {
      ...process.env,
      OPENCLAW_SHELL: "",
      CODEX_THREAD_ID: "",
      OPENCLAW_UPDATE_RUN_HANDOFF: "",
      OPENCLAW_SUPERVISOR_MODE: "",
      OPENCLAW_LAUNCHD_LABEL: "",
      OPENCLAW_SYSTEMD_UNIT: "",
      OPENCLAW_STATE_DIR: path.join(root, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(root, ".openclaw/openclaw.json"),
      OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
      ...triageRuntimePreloadEnv(),
      TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      forceKillChildProcessTree(child);
    }
    await closed;
  });
  return closed.then((exit) => ({ exit, stdout, stderr, pid: child.pid }));
}

const unix = process.platform === "win32" ? it.skip : it;
unix("releases a failed triage reservation before the next sequential attempt", async () => {
  const root = triageLeaseFixtureLifetime.createTempDir("triage-holder-");
  const source = (entry: keyof typeof triageTestRuntimeEntrypoints) =>
    JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints[entry]).href);
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module","name":"openclaw"}');
  await fs.writeFile(path.join(root, "dist/index.js"), "await import('../candidate.mjs');");
  await fs.writeFile(
    path.join(root, "candidate.mjs"),
    `
import fs from 'node:fs';
import {acceptTriageContinuation} from ${source("continuation")};
const admission=await acceptTriageContinuation();
admission.assertCurrent();
fs.writeFileSync(${JSON.stringify(path.join(root, "completed.receipt"))},String(process.pid),{flag:'wx'});
await admission.finish('closed');
`,
  );
  // #168859: "the rare disappearance can fail once"; reserved work must release before the next attempt.
  await fs.writeFile(
    path.join(root, "foreground.mjs"),
    `
import fs from 'node:fs'; import {DatabaseSync} from 'node:sqlite';
import {FsSafeError} from ${JSON.stringify(import.meta.resolve("@openclaw/fs-safe/errors"))};
import {triageAfterFailure} from ${source("failure")};
const phase=process.argv[2],root=${JSON.stringify(root)},databasePath=${JSON.stringify(resolveManagedUpdateLeaseDatabasePath())};
const report=(message)=>{
  console.error(message);
  if(!message.startsWith('Automatic triage is preparing the installed CLI;'))return;
  const db=new DatabaseSync(databasePath,{readOnly:true});
  try {
    const row=db.prepare('SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?').get(root);
    fs.writeFileSync(root+'/'+phase+'.reserved.json',JSON.stringify(row),{flag:'wx'});
  } finally {db.close();}
  if(phase!=='failed')return;
  const open=fs.openSync;
  fs.openSync=function(file,flags,...rest){
    if(file!==databasePath+'.lock' || !(flags & fs.constants.O_EXCL))return open.call(this,file,flags,...rest);
    fs.openSync=open;
    fs.writeFileSync(root+'/fault',String(file),{flag:'wx'});
    throw new FsSafeError('path-mismatch','sidecar changed during reclaim policy callback');
  };
};
process.stdout.write('{"status":"error","reason":"original"}\\n');
const completion=await triageAfterFailure({log:report,error:report,exit:()=>{throw new Error('original exit overwritten');}},
  {kind:'update',phase,error:'original',installationRoot:root,gateway:'preserve'});
console.error('triage-completion:'+completion);
process.exitCode=7;
`,
  );
  const failed = await foreground(root, "failed");
  const diagnostics = JSON.stringify(failed);
  expect(expectTriageDenial(failed), diagnostics).toBe(true);
  const reserved = JSON.parse(await fs.readFile(path.join(root, "failed.reserved.json"), "utf8"));
  const payload = JSON.parse(reserved.payload_json);
  expect(payload.action.phase, diagnostics).toBe("reserved");
  expect(payload.helper.pid, diagnostics).toBe(failed.pid);
  expect(await fs.readFile(path.join(root, "fault"), "utf8"), diagnostics).toBe(
    `${resolveManagedUpdateLeaseDatabasePath()}.lock`,
  );
  expect(await fs.readdir(root), diagnostics).not.toContain("completed.receipt");
  await expectReleasedTriage(root, diagnostics);

  const next = await foreground(root, "next");
  expectTriageCompleted(next);
  const nextReservation = JSON.parse(
    await fs.readFile(path.join(root, "next.reserved.json"), "utf8"),
  );
  expect(nextReservation.owner).not.toBe(reserved.owner);
  expect(JSON.parse(nextReservation.payload_json).action.phase).toBe("reserved");
  expect(isPidAlive(Number(await fs.readFile(path.join(root, "completed.receipt"), "utf8")))).toBe(
    false,
  );
  await expectReleasedTriage(root, JSON.stringify(next));
});
