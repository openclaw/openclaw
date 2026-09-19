import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  readScheduledTaskDefinition,
  restoreScheduledTaskDefinition,
  resumeScheduledTaskAutoStartAfterUpdate,
  setScheduledTaskXmlEnabled,
  suspendScheduledTaskAutoStartForUpdate,
} from "./schtasks-control.js";
import { execSchtasks } from "./schtasks-exec.js";
import { resolveTaskName } from "./schtasks-layout.js";
import {
  shouldManageGatewayListenerPort,
  terminateScheduledTaskGatewayListeners,
  terminateScheduledTaskNodeHost,
} from "./schtasks-process.js";
import {
  isScheduledTaskDefinitelyNotRunning,
  resolveFallbackRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists, probeScheduledTaskState } from "./schtasks-state-probe.js";
import { publishServiceFile, readServiceFileState } from "./service-stage.js";
import type { GatewayServiceEnv, GatewayServiceInstallArgs } from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceInstallationRecovery,
} from "./service-update-authority.js";

type TaskFile = { path: string; contents: Buffer };
type TaskFileState = NonNullable<Awaited<ReturnType<typeof readServiceFileState>>>;
type TaskFileSnapshot = TaskFile & {
  original: { contents: Buffer; state: TaskFileState } | null;
  after: TaskFileState | null;
  prepared: TaskFileState | null;
  changed: boolean;
};

async function publishTaskFile(file: TaskFile): Promise<void> {
  await publishServiceFile({ filePath: file.path, contents: file.contents, mode: 0o600 });
}

export async function backupScheduledTaskDefinition(env: GatewayServiceEnv, scriptPath: string) {
  const taskName = resolveTaskName(env);
  const readXml = async () => {
    try {
      return await readScheduledTaskDefinition(env);
    } catch (error) {
      assertGatewayServiceUpdateCurrent();
      if (probeScheduledTaskExists(taskName) === false) {
        return null;
      }
      throw new Error(`Could not back up Scheduled Task ${taskName} before replacement.`, {
        cause: error,
      });
    }
  };
  const original = await readXml();
  const originalRuntime = original === null ? null : probeScheduledTaskState(taskName);
  const backupPath = `${scriptPath}.task.xml.bak`;
  if (original !== null) {
    assertGatewayServiceUpdateCurrent();
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await publishTaskFile({
      path: backupPath,
      contents: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(original, "utf16le")]),
    });
  }
  let receipt = original;
  let changed = false;
  let unsettled = false;
  // Disabling is our only allowed registration change during settlement.
  const withoutEnabled = (xml: string | null) =>
    xml === null ? null : setScheduledTaskXmlEnabled(xml, false);
  const assertReceipt = async (disabled = false) => {
    const current = unsettled ? null : await readXml();
    if (
      unsettled ||
      (disabled ? withoutEnabled(current) !== withoutEnabled(receipt) : current !== receipt)
    ) {
      throw new Error(`Scheduled Task ${taskName} registration ownership could not be verified.`);
    }
  };
  return {
    registered: original !== null,
    retainRecovery: () => {
      unsettled = true;
    },
    recordRegistration: async () => {
      changed = true;
      unsettled = true;
      receipt = await readXml();
      if (receipt === null) {
        throw new Error(`Scheduled Task ${taskName} registration disappeared after replacement.`);
      }
      unsettled = false;
    },
    restore: async (
      files: { assertPublished: () => Promise<void>; restore: () => Promise<boolean> },
      activated: boolean,
    ) => {
      await files.assertPublished();
      await assertReceipt();
      if (changed || activated) {
        const disabled = await execSchtasks(["/Change", "/TN", taskName, "/DISABLE"]);
        if (disabled.code !== 0) {
          throw new Error(`Could not disable Scheduled Task ${taskName} before restoring it.`);
        }
        await execSchtasks(["/End", "/TN", taskName]);
        const probe = probeScheduledTaskState(taskName);
        if (
          probe.status !== "found" ||
          probe.enabled !== false ||
          !isScheduledTaskDefinitelyNotRunning(taskName)
        ) {
          throw new Error(`Scheduled Task ${taskName} may still be queued or running.`);
        }
        if (activated) {
          const runtime = await resolveFallbackRuntime(env, undefined, "control");
          if (runtime.status === "running") {
            if (shouldManageGatewayListenerPort(env)) {
              await terminateScheduledTaskGatewayListeners(env);
            } else {
              await terminateScheduledTaskNodeHost(env);
            }
          }
          if (
            runtime.status === "unknown" ||
            (await resolveFallbackRuntime(env, undefined, "control")).status !== "stopped"
          ) {
            throw new Error(`Scheduled Task ${taskName} replacement process did not settle.`);
          }
        }
        await assertReceipt(true);
      }
      const restoredFiles = await files.restore();
      if (!changed && !activated) {
        return restoredFiles;
      }
      if (original === null) {
        const deleted = await execSchtasks(["/Delete", "/F", "/TN", taskName]);
        if (deleted.code !== 0) {
          throw new Error(`Could not remove replacement Scheduled Task ${taskName}.`);
        }
      } else {
        await restoreScheduledTaskDefinition({
          env,
          xml: original,
          beforeWrite: () => assertReceipt(true),
          assertCurrent: assertGatewayServiceUpdateCurrent,
        });
        receipt = setScheduledTaskXmlEnabled(original, false);
        await assertReceipt();
        if (
          originalRuntime?.status !== "found" ||
          typeof originalRuntime.enabled !== "boolean" ||
          (originalRuntime.state !== 1 &&
            originalRuntime.state !== 3 &&
            originalRuntime.state !== 4)
        ) {
          throw new Error(
            `Scheduled Task ${taskName} previous running state could not be verified.`,
          );
        }
        // Definition restoration preserves settlement's disabled state; policy is owned here.
        if (originalRuntime.enabled) {
          await resumeScheduledTaskAutoStartAfterUpdate(env, { beforeMutation: assertReceipt });
          receipt = setScheduledTaskXmlEnabled(original, true);
          await assertReceipt();
        }
        if (originalRuntime.state === 4) {
          // Disabling a running task only suspends its triggers; preserve both prior facts.
          const restoreDisabled = !originalRuntime.enabled;
          try {
            if (restoreDisabled) {
              await resumeScheduledTaskAutoStartAfterUpdate(env, { beforeMutation: assertReceipt });
            }
            const run = await execSchtasks(["/Run", "/TN", taskName]);
            if (
              run.code !== 0 ||
              (restoreDisabled && !(await waitForScheduledTaskRunningEvidence(env)))
            ) {
              throw new Error(
                `Scheduled Task ${taskName} previous launch did not confirm completion.`,
              );
            }
          } finally {
            if (restoreDisabled) {
              await suspendScheduledTaskAutoStartForUpdate(env, {
                beforeMutation: () => assertReceipt(true),
                restoreOnFailure: false,
              });
              await assertReceipt();
            }
          }
          if (!(await waitForScheduledTaskRunningEvidence(env))) {
            throw new Error(
              `Scheduled Task ${taskName} previous running state could not be restored.`,
            );
          }
        }
      }
      return true;
    },
  };
}

/** Capture every launcher before replacing any part of the runnable definition. */
export async function publishScheduledTaskFiles(
  files: TaskFile[],
  definitionTransaction?: GatewayServiceInstallArgs["definitionTransaction"],
) {
  if (definitionTransaction) {
    for (const file of files) {
      assertGatewayServiceUpdateCurrent();
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await publishServiceFile({
        filePath: file.path,
        contents: file.contents,
        mode: 0o600,
        definitionTransaction,
      });
    }
    return undefined;
  }
  const snapshots = await withGatewayServiceInstallationRecovery(
    () =>
      Promise.all(
        files.map(async (file): Promise<TaskFileSnapshot> => {
          const before = await readServiceFileState(file.path);
          const previous = before ? await fs.readFile(file.path) : null;
          if (previous && sha256Hex(previous) !== before?.sha256) {
            throw new Error(`Task launcher changed during backup: ${file.path}`);
          }
          return {
            ...file,
            original: before && previous ? { contents: previous, state: before } : null,
            after: before,
            prepared: null,
            changed: false,
          };
        }),
      ),
    async () => false,
  );
  const assertPublished = async () => {
    for (const file of snapshots) {
      const current = await readServiceFileState(file.path);
      const prepared = file.prepared;
      if (prepared) {
        // Rename can change ctime; the prepared inode and payload identify our publication.
        if (
          current &&
          (["dev", "ino", "sha256", "mode", "size", "mtimeMs"] as const).every(
            (key) => current[key] === prepared[key],
          )
        ) {
          file.after = current;
          file.changed = true;
        } else if (!isDeepStrictEqual(current, file.after)) {
          throw new Error(`Task launcher changed during publication: ${file.path}`);
        }
        file.prepared = null;
      }
      if (!isDeepStrictEqual(current, file.after)) {
        throw new Error(`Task launcher changed after publication: ${file.path}`);
      }
    }
  };
  const publish = (file: (typeof snapshots)[number], contents: Buffer, mode: number) =>
    publishServiceFile({
      filePath: file.path,
      contents,
      mode,
      definitionTransaction: {
        assertCurrent: assertGatewayServiceUpdateCurrent,
        beforeWrite: assertPublished,
        filePrepared: async (_source, temporary) => {
          const prepared = temporary === null ? null : await readServiceFileState(temporary);
          if (!prepared) {
            throw new Error(`Task launcher publication was not staged: ${file.path}`);
          }
          await assertPublished();
          file.prepared = prepared;
        },
        fileWritten: assertPublished,
        taskPrepared: async () => {},
        taskWritten: async () => {},
      },
    });
  const restore = async () => {
    await assertPublished();
    const changed = snapshots.filter((file) => file.changed);
    for (const file of changed.toReversed()) {
      if (file.original) {
        await publish(file, file.original.contents, file.original.state.mode);
      } else {
        await assertPublished();
        assertGatewayServiceUpdateCurrent();
        await fs.unlink(file.path);
        file.after = null;
      }
    }
    await assertPublished();
    return changed.length > 0;
  };
  return withGatewayServiceInstallationRecovery(async () => {
    for (const directory of new Set(files.map((file) => path.dirname(file.path)))) {
      assertGatewayServiceUpdateCurrent();
      await fs.mkdir(directory, { recursive: true });
    }
    for (const file of snapshots) {
      if (file.original) {
        await publishTaskFile({ path: `${file.path}.bak`, contents: file.original.contents });
      }
    }
    for (const file of snapshots) {
      await publish(file, file.contents, 0o600);
    }
    return { restore, assertPublished };
  }, restore);
}
