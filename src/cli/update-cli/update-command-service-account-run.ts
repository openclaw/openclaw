import fs from "node:fs/promises";
import path from "node:path";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { serviceAccountArgv } from "../../daemon/systemd-service-account-command.js";
import { runCommandBuffered, type BufferedCommandResult } from "../../process/exec.js";
import type { SystemServiceAccountPlan } from "./update-command-admit-service-account.js";

export type ServiceAccountExecution = Extract<SystemServiceAccountPlan, { kind: "switch" }>;

/** The only environment root's runuser gets; the unit's environment applies after the switch. */
export const SERVICE_ACCOUNT_LAUNCH_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Runs as the account: loads the unit's environment from the handoff file and executes the
 * release entry with exactly that environment. Loader variables such as LD_PRELOAD from the
 * unit therefore never reach a root process.
 */
export const SERVICE_ACCOUNT_ENV_LOADER = [
  "const [file, ...argv] = process.argv.slice(1);",
  'const env = JSON.parse(require("node:fs").readFileSync(file, "utf8"));',
  'const run = require("node:child_process").spawnSync(process.execPath, argv, { env, stdio: "inherit" });',
  "process.exit(typeof run.status === 'number' ? run.status : 1);",
].join("\n");

/**
 * Files root hands to the unit's account: a fresh root-owned directory that others may only
 * traverse, and files only that account can read. Root never reads them back.
 */
export type ServiceAccountHandoff = {
  directory: string;
  envFile: string;
  write: (name: string, contents: string) => Promise<string>;
  remove: () => Promise<void>;
};

const HANDOFF_PARENT = "/tmp";

export async function createServiceAccountHandoff(
  execution: ServiceAccountExecution,
  env: Record<string, string> = {},
): Promise<ServiceAccountHandoff> {
  // Not os.tmpdir(): an updater's temp directory is often private to root, and the account
  // must be able to traverse to the file. /tmp must be root's sticky directory, so nobody
  // else can rename the directory created in it.
  const parentPath = await fs.realpath(HANDOFF_PARENT);
  const parent = await fs.lstat(parentPath);
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o1000) === 0) {
    throw new Error(`${HANDOFF_PARENT} is not a root-owned sticky directory.`);
  }
  const directory = await fs.mkdtemp(path.join(parentPath, "openclaw-update-handoff-"));
  const remove = () => fs.rm(directory, { recursive: true, force: true });
  const write = async (name: string, contents: string) => {
    const file = path.join(directory, name);
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.chown(execution.uid, execution.gid);
      await handle.chmod(0o400);
    } finally {
      await handle.close();
    }
    return file;
  };
  try {
    await fs.chmod(directory, 0o711);
    const envFile = await write("env.json", JSON.stringify({ ...execution.env, ...env }));
    return { directory, envFile, write, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

/**
 * Run this release's own entry point as the unit's account with the unit's environment.
 * Privilege only goes down: root never executes anything the account produced, and callers
 * treat the returned exit status and bounded output as untrusted input.
 */
export async function runReleaseAsServiceAccount(
  execution: ServiceAccountExecution,
  handoff: ServiceAccountHandoff,
  params: {
    root: string;
    args: string[];
    timeoutMs: number;
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
      argv: [
        process.execPath,
        "-e",
        SERVICE_ACCOUNT_ENV_LOADER,
        handoff.envFile,
        entry,
        ...params.args,
      ],
    }),
    {
      // Neither root's working directory nor any path the account owns.
      cwd: "/",
      baseEnv: {},
      env: { PATH: SERVICE_ACCOUNT_LAUNCH_PATH },
      input: "",
      timeoutMs: params.timeoutMs,
      maxOutputBytes: { stdout: params.maxStdoutBytes ?? 1024 * 1024, stderr: 64 * 1024 },
      killProcessTree: true,
    },
  );
}
