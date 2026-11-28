import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { serviceAccountArgv } from "../../daemon/systemd-service-account-command.js";
import { runCommandBuffered, type BufferedCommandResult } from "../../process/exec.js";
import type { SystemServiceAccountPlan } from "./update-command-admit-service-account.js";

export type ServiceAccountExecution = Extract<SystemServiceAccountPlan, { kind: "switch" }>;

/**
 * Run this release's own entry point as the unit's account with the unit's environment.
 * Privilege only goes down: root never executes anything the account produced, and callers
 * treat the returned exit status and bounded output as untrusted input.
 */
export async function runReleaseAsServiceAccount(
  execution: ServiceAccountExecution,
  params: {
    root: string;
    args: string[];
    timeoutMs: number;
    /** Release runtime selectors the parent set for this candidate, never root's state selectors. */
    env?: Record<string, string>;
    maxStdoutBytes?: number;
  },
): Promise<BufferedCommandResult> {
  const entry = await resolveGatewayInstallEntrypoint(params.root);
  if (!entry) {
    throw new Error("The release entry point is unavailable.");
  }
  return await runCommandBuffered(
    serviceAccountArgv({
      runuser: execution.runuser,
      account: execution.account,
      argv: [process.execPath, entry, ...params.args],
      preserveEnvironment: true,
    }),
    {
      // Neither root's working directory nor any path the account owns.
      cwd: "/",
      baseEnv: {},
      env: { ...execution.env, ...params.env },
      input: "",
      timeoutMs: params.timeoutMs,
      maxOutputBytes: { stdout: params.maxStdoutBytes ?? 1024 * 1024, stderr: 64 * 1024 },
      killProcessTree: true,
    },
  );
}

/**
 * Hand one file to the unit's account: a fresh root-owned directory and file readable by the
 * account's group only, so the account can read it and nobody but root can replace it.
 */
export async function withServiceAccountHandoff<T>(
  execution: ServiceAccountExecution,
  name: string,
  contents: string,
  run: (file: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-handoff-"));
  try {
    await fs.chown(directory, process.getuid?.() ?? 0, execution.gid);
    await fs.chmod(directory, 0o750);
    const file = path.join(directory, name);
    const handle = await fs.open(file, "wx", 0o640);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.chown(process.getuid?.() ?? 0, execution.gid);
      await handle.chmod(0o640);
    } finally {
      await handle.close();
    }
    return await run(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
