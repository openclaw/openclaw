import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BaseProbeResult } from "../channels/plugins/types.js";

const execFileAsync = promisify(execFile);

export type KeybaseProbe = BaseProbeResult & {
  elapsedMs: number;
  username?: string | null;
};

export async function probeKeybase(_unused: string, timeoutMs: number): Promise<KeybaseProbe> {
  const started = Date.now();
  const result: KeybaseProbe = {
    ok: false,
    error: null,
    elapsedMs: 0,
    username: null,
  };

  try {
    const { stdout } = await execFileAsync("keybase", ["status", "--json"], {
      timeout: timeoutMs,
    });
    const status = JSON.parse(stdout) as {
      Username?: string;
      LoggedIn?: boolean;
    };
    if (!status.LoggedIn) {
      return {
        ...result,
        error: "Keybase CLI is not logged in",
        elapsedMs: Date.now() - started,
      };
    }
    return {
      ...result,
      ok: true,
      username: status.Username ?? null,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ...result,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}
