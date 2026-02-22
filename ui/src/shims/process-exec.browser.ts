export function shouldSpawnWithShell(): boolean {
  return false;
}

export async function runExec(): Promise<{ stdout: string; stderr: string }> {
  throw new Error("runExec is not available in browser builds");
}

export async function runCommandWithTimeout(): Promise<never> {
  throw new Error("runCommandWithTimeout is not available in browser builds");
}
