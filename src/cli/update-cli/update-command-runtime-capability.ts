import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";

/** This bounded read establishes compatibility only; callers retain all mutation authority. */
export async function inspectUpdateRuntimeCapability(params: {
  command: string[];
  root: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}) {
  const check = await runUtf8CommandWithTimeout([...params.command, "--check"], {
    cwd: params.root,
    baseEnv: {},
    env: params.env,
    timeoutMs: Math.min(30_000, params.timeoutMs ?? 30_000),
    killProcessTree: true,
    requireProcessTreeExtinction: true,
    killGraceMs: 500,
    maxOutputBytes: 64 * 1024,
  });
  let contract: Record<string, unknown> | undefined;
  let parseError: unknown;
  try {
    const parsed: unknown = JSON.parse(check.stdout);
    if (isRecord(parsed)) {
      contract = parsed;
    }
  } catch (error) {
    parseError = error;
  }
  return { check, contract, parseError };
}
