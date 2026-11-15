import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import { realpathForExec } from "../infra/exec-command-resolution.js";
import { resolveExecutableFromPathEnvAsync } from "../infra/executable-path.js";
import type { NodeHostClient } from "./client.js";

export async function resolveExecutableTrustPathFromEnv(
  bin: string,
  pathEnv: string,
): Promise<string | null> {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  const resolvedPath = await resolveExecutableFromPathEnvAsync(bin, pathEnv);
  if (!resolvedPath) {
    return null;
  }
  try {
    return await realpathForExec(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

async function resolveSkillBinTrustEntries(
  bins: string[],
  pathEnv: string,
): Promise<SkillBinTrustEntry[]> {
  const trustEntries = new Map<string, SkillBinTrustEntry>();
  for (const raw of bins) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    const resolvedPath = await resolveExecutableTrustPathFromEnv(name, pathEnv);
    if (!resolvedPath) {
      continue;
    }
    trustEntries.set(`${name}\u0000${resolvedPath}`, { name, resolvedPath });
  }
  return [...trustEntries.values()].toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.resolvedPath.localeCompare(right.resolvedPath),
  );
}

export class SkillBinsCache {
  private bins: SkillBinTrustEntry[] = [];
  private lastRefresh = 0;
  private refreshInFlight: Promise<void> | undefined;
  private readonly ttlMs = 90_000;

  constructor(
    private readonly client: NodeHostClient,
    private readonly pathEnv: string,
  ) {}

  async current(): Promise<SkillBinTrustEntry[]> {
    if (Date.now() - this.lastRefresh > this.ttlMs) {
      this.refreshInFlight ??= this.refresh().finally(() => {
        this.refreshInFlight = undefined;
      });
      await this.refreshInFlight;
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const res = await this.client.request<{ bins: Array<unknown> }>("skills.bins", {});
      const bins = Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
      this.bins = await resolveSkillBinTrustEntries(bins, this.pathEnv);
      this.lastRefresh = Date.now();
    } catch {
      // Keep the previous inventory until the next refresh, including an empty first load.
    }
  }
}

export type SkillBinsProvider = Pick<SkillBinsCache, "current">;
