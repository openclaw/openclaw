import { runUtf8CommandWithTimeout } from "../process/exec.js";

export async function claudeAdvertisesSafeMode(params: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<boolean> {
  const help = await runUtf8CommandWithTimeout([...params.argv, "--help"], {
    env: params.env,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    timeoutMs: 10_000,
    killProcessTree: true,
    outputCapture: "tail",
    maxOutputBytes: 64 * 1024,
  });
  return (
    help.termination === "exit" &&
    help.code === 0 &&
    `${help.stdout}\n${help.stderr}`.includes("--safe-mode")
  );
}
