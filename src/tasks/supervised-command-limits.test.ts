import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getSupervisedCommandResources } from "./supervised-command-custody.js";
import { launchSupervisedOperationProcess } from "./supervised-operation.launch.js";
import {
  enqueueSupervisedOperation,
  getSupervisedOperation,
  getSupervisedOperationExecution,
} from "./supervised-operation.store.js";
import {
  claimSupervisedTask,
  createSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
  stopTaskSupervisor,
} from "./supervised-task.store.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import { resolveSupervisedWorkflowWorkspace } from "./supervised-workspace-versions.js";

const dirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe.skipIf(process.platform !== "linux")("kernel-enforced command resource limits", () => {
  it("enforces storage, inode, namespace and process bounds before accepting the private result", async () => {
    const root = dirs.make("openclaw-independent-operation-");
    const workspace = `${root}/work`;
    await fs.mkdir(workspace);
    await fs.writeFile(`${workspace}/source.txt`, "accepted source\n");
    const now = Date.now();
    const options = { env: { OPENCLAW_STATE_DIR: `${root}/state` } };
    const goal = {
      objective: "Exercise independent process custody",
      success: [{ id: "effect", description: "One observed effect" }],
      partial: [],
    };
    const workflow = encodeSupervisedWorkflowContract(
      {
        version: 1,
        workspace,
        sourcePaths: ["."],
        profiles: [
          {
            kind: "command",
            id: "effect",
            executable: process.execPath,
            executableSha256: createHash("sha256")
              .update(await fs.readFile(process.execPath))
              .digest("hex"),
            argv: [
              "--input-type=module",
              "-e",
              "import fs from 'node:fs';\nimport cp from 'node:child_process';\nimport assert from 'node:assert/strict';\nfor (const root of ['/work','/tmp','/home','/dev/shm']) {\n  assert.throws(() => fs.writeFileSync(root+'/overflow', Buffer.alloc(16*1024*1024)), e => e.code === 'ENOSPC');\n  fs.rmSync(root+'/overflow', {force:true});\n}\nlet inodes=0, inodeBound=false;\ntry { for (;inodes<512;inodes++) fs.writeFileSync('/tmp/i'+inodes,''); }\ncatch(e) { if(e.code!=='ENOSPC') throw e; inodeBound=true; }\nassert.ok(inodeBound);\nfor(let i=0;i<inodes;i++) fs.unlinkSync('/tmp/i'+i);\nconst nested=cp.spawnSync('/usr/bin/unshare',['--user','/usr/bin/true'],{encoding:'utf8'});\nassert.notEqual(nested.status,0);\nassert.match(nested.stderr,/No space left on device/);\nconst children=[];\nlet processBound=false;\ntry {\n  for (let i=0;i<128;i++) {\n    const child=cp.spawn('/usr/bin/sleep',['30'],{stdio:'ignore'});\n    try { await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}); }\n    catch(e) { if(e.code!=='EAGAIN') throw e; processBound=true; break; }\n    children.push(child);\n  }\n} finally {\n  await Promise.all(children.map(child=>new Promise(resolve=>{\n    child.once('exit',resolve); child.kill('SIGKILL');\n  })));\n}\nassert.ok(processBound);\nfs.writeFileSync('effects.txt','one\\n');\nconsole.log('limits enforced');",
            ],
            resourceLimits: {
              memoryBytes: 1024 * 1024 * 1024,
              tasks: 64,
              workingBytes: 8 * 1024 * 1024,
              workingInodes: 128,
            },
            writable: true,
            timeoutMs: 20_000,
          },
        ],
        acceptance: [{ kind: "receipts", criterionId: "effect", profiles: ["effect"] }],
      },
      goal,
    ).contract;
    heartbeatTaskSupervisor("coordinator", now, 10_000, options);
    const task = createSupervisedTask(
      {
        agentId: "poc",
        runtime: "codex",
        model: "openai/test",
        prompt: "Run accepted operation",
        goal,
        workflow,
        policy: { deadlineAt: now + 60_000, attemptTimeoutMs: 10_000, maxAttempts: 4 },
      },
      "coordinator",
      now,
      options,
    );
    const attempt = reserveSupervisedDispatch(
      claimSupervisedTask(task.flowId, "coordinator", now, options)!,
      now,
      options,
    );
    const operation = enqueueSupervisedOperation(
      attempt,
      { key: "once", kind: "command", profile: "effect" },
      now,
      options,
    );
    await Promise.all([
      launchSupervisedOperationProcess(operation.operationId, options),
      launchSupervisedOperationProcess(operation.operationId, options),
    ]);
    stopTaskSupervisor("coordinator", Date.now(), options);
    await expect
      .poll(
        () => {
          const observed = getSupervisedOperation(operation.operationId, options);
          if (observed?.state === "reconciling") {
            throw new Error(
              JSON.stringify({
                operation: observed,
                execution: observed.executionId
                  ? getSupervisedOperationExecution(observed.executionId, options)
                  : null,
              }),
            );
          }
          return observed?.outcome;
        },
        {
          timeout: 45_000,
          interval: 250,
        },
      )
      .toBeTruthy();
    expect(getSupervisedOperation(operation.operationId, options)?.outcome).toMatchObject({
      status: "succeeded",
      facts: { exitCode: "0", stderr: "" },
    });
    await expect(fs.readFile(`${workspace}/effects.txt`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const accepted = resolveSupervisedWorkflowWorkspace(
      workflow,
      task.flowId,
      task.episode,
      options,
    );
    expect(await fs.readFile(`${accepted.workspace}/effects.txt`, "utf8")).toBe("one\n");
    const result = getSupervisedOperation(operation.operationId, options)!;
    expect(result.generation).toBe(1);
    expect(getSupervisedCommandResources(result.executionId!, options)).toMatchObject({
      state: "closed",
      identity: { limits: { memoryBytes: 1024 * 1024 * 1024, tasks: 64 } },
    });
    expect(result.outcome?.facts).toMatchObject({
      exitCode: "0",
      stdout: "limits enforced\n",
      cleanup: "observed",
    });
  }, 60_000);
});
