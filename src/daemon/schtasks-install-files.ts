import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { execSchtasks } from "./schtasks-exec.js";
import { resolveTaskName, writeTaskXmlTempFile } from "./schtasks-layout.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

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
  const backupPath = `${scriptPath}.task.xml.bak`;
  assertGatewayServiceUpdateCurrent();
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await publishTaskFile({
    path: backupPath,
    contents: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]),
  });
  return async () => {
    const temporary = await writeTaskXmlTempFile(xml);
    try {
      const restored = await execSchtasks(["/Create", "/F", "/TN", taskName, "/XML", temporary]);
      if (restored.code !== 0) {
        throw new Error(`Could not restore Scheduled Task ${taskName} from ${backupPath}.`);
      }
    } finally {
      await fs.rm(path.dirname(temporary), { recursive: true, force: true });
    }
  };
}

/** Capture every launcher before replacing any part of the runnable definition. */
export async function publishScheduledTaskFiles(files: TaskFile[]) {
  const snapshots = await Promise.all(
    files.map(async (file) => ({
      ...file,
      previous: await fs.readFile(file.path).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      }),
    })),
  );
  const published: typeof snapshots = [];
  const restore = async () => {
    for (const file of published.toReversed()) {
      const current = await fs.readFile(file.path);
      if (!current.equals(file.contents)) {
        throw new Error(`Task launcher changed after publication: ${file.path}`);
      }
      if (file.previous) {
        await publishTaskFile({ path: file.path, contents: file.previous });
      } else {
        assertGatewayServiceUpdateCurrent();
        await fs.unlink(file.path);
      }
    }
  };
  try {
    for (const file of snapshots) {
      if (file.previous) {
        await publishTaskFile({ path: `${file.path}.bak`, contents: file.previous });
      }
    }
    for (const file of snapshots) {
      await publishTaskFile(file);
      published.push(file);
    }
  } catch (error) {
    try {
      await restore();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Task launcher publication failed and its previous files could not be restored; inspect the .bak files beside the task launchers.",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  return { restore };
}
