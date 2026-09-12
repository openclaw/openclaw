import { runUtf8CommandWithTimeout } from "../process/exec.js";

type ClaudeSafeModeProbeResult = { ok: true; supported: boolean } | { ok: false; error: unknown };

export async function probeClaudeSafeMode(params: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<ClaudeSafeModeProbeResult> {
  try {
    const help = await runUtf8CommandWithTimeout([...params.argv, "--help"], {
      env: params.env,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      timeoutMs: 10_000,
      killProcessTree: true,
      outputCapture: "tail",
      maxOutputBytes: 64 * 1024,
    });
    return {
      ok: true,
      supported:
        help.termination === "exit" &&
        help.code === 0 &&
        `${help.stdout}\n${help.stderr}`.includes("--safe-mode"),
    };
  } catch (error) {
    return { ok: false, error };
  }
}
