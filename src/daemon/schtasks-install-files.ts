import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "./schtasks-control.js";
import { execSchtasks } from "./schtasks-exec.js";
import { resolveTaskName, writeTaskXmlTempFile } from "./schtasks-layout.js";
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
import type { GatewayServiceEnv } from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceInstallationRecovery,
} from "./service-update-authority.js";

type TaskFile = { path: string; contents: Buffer };

async function publishTaskFile(file: TaskFile): Promise<void> {
  const temporary = `${file.path}.${randomUUID()}.tmp`;
  try {
    assertGatewayServiceUpdateCurrent();
    await fs.writeFile(temporary, file.contents, { flag: "wx", mode: 0o600 });
    assertGatewayServiceUpdateCurrent();
    await fs.rename(temporary, file.path);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function backupScheduledTaskDefinition(env: GatewayServiceEnv, scriptPath: string) {
  const taskName = resolveTaskName(env);
  const readXml = async () => {
    const query = await execSchtasks(["/Query", "/TN", taskName, "/XML"]);
    if (query.code !== 0) {
      const missing =
        query.code !== 124 &&
        (query.stderr || query.stdout).toLowerCase().includes("cannot find the file");
      if (missing || probeScheduledTaskExists(taskName) === false) {
        return null;
      }
      throw new Error(`Could not back up Scheduled Task ${taskName} before replacement.`);
    }
    const xml = query.stdout.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "");
    if (!/<Task[\s>]/u.test(xml)) {
      throw new Error(`Scheduled Task ${taskName} did not return a restorable XML definition.`);
    }
    return xml;
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
    xml?.replace(
      /(<Settings(?:\s[^>]*)?>[\s\S]*?<Enabled>)\s*(?:true|false)\s*(<\/Enabled>)/u,
      "$1$2",
    );
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
        const temporary = await writeTaskXmlTempFile(original);
        try {
          const restored = await execSchtasks([
            "/Create",
            "/F",
            "/TN",
            taskName,
            "/XML",
            temporary,
          ]);
          if (restored.code !== 0 || (await readXml()) !== original) {
            throw new Error(`Could not restore Scheduled Task ${taskName} from ${backupPath}.`);
          }
          receipt = original;
        } finally {
          await fs.rm(path.dirname(temporary), { recursive: true, force: true });
        }
        if (
          originalRuntime?.status !== "found" ||
          (originalRuntime.state !== 1 &&
            originalRuntime.state !== 3 &&
            originalRuntime.state !== 4)
        ) {
          throw new Error(
            `Scheduled Task ${taskName} previous running state could not be verified.`,
          );
        }
        if (originalRuntime.state === 4) {
          // Disabling a running task only suspends its triggers; preserve both prior facts.
          const restoreDisabled = originalRuntime.enabled === false;
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
export async function publishScheduledTaskFiles(files: TaskFile[]) {
  const snapshots = await withGatewayServiceInstallationRecovery(
    () =>
      Promise.all(
        files.map(async (file) => ({
          ...file,
          previous: await fs.readFile(file.path).catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return null;
            }
            throw error;
          }),
        })),
      ),
    async () => false,
  );
  const published: typeof snapshots = [];
  const assertPublished = async () => {
    for (const file of published) {
      if (!(await fs.readFile(file.path)).equals(file.contents)) {
        throw new Error(`Task launcher changed after publication: ${file.path}`);
      }
    }
  };
  const restore = async () => {
    await assertPublished();
    for (const file of published.toReversed()) {
      if (file.previous) {
        await publishTaskFile({ path: file.path, contents: file.previous });
      } else {
        assertGatewayServiceUpdateCurrent();
        await fs.unlink(file.path);
      }
    }
    return published.length > 0;
  };
  return withGatewayServiceInstallationRecovery(async () => {
    for (const directory of new Set(files.map((file) => path.dirname(file.path)))) {
      assertGatewayServiceUpdateCurrent();
      await fs.mkdir(directory, { recursive: true });
    }
    for (const file of snapshots) {
      if (file.previous) {
        await publishTaskFile({ path: `${file.path}.bak`, contents: file.previous });
      }
    }
    for (const file of snapshots) {
      await publishTaskFile(file);
      published.push(file);
    }
    return { restore, assertPublished };
  }, restore);
}
