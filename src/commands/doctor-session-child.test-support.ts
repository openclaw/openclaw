import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runDoctorChild(args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, args, { env, timeout: 60_000 });
  return JSON.parse(stdout);
}
