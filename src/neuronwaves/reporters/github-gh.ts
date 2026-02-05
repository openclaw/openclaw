import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function tryPostGhPrComment(params: {
  repo: string;
  prNumber: number;
  body: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { repo, prNumber, body } = params;
  try {
    // best-effort: requires gh installed + authenticated.
    await execFileAsync("gh", ["pr", "comment", String(prNumber), "--repo", repo, "--body", body], {
      windowsHide: true,
      timeout: 20_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}
