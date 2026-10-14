import fs from "node:fs";
import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import type { NodeHostClient } from "./client.js";
import type { SkillBinsProvider } from "./invoke-types.js";

export function resolveExecutableTrustPathFromEnv(bin: string, pathEnv: string): string | null {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  const resolvedPath = resolveExecutableFromPathEnv(bin, pathEnv);
  if (!resolvedPath) {
    return null;
  }
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function resolveSkillBinTrustEntries(bins: string[], pathEnv: string): SkillBinTrustEntry[] {
  const trustEntries = new Map<string, SkillBinTrustEntry>();
  for (const raw of bins) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    const resolvedPath = resolveExecutableTrustPathFromEnv(name, pathEnv);
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

export class SkillBinsCache implements SkillBinsProvider {
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
      this.bins = resolveSkillBinTrustEntries(bins, this.pathEnv);
      this.lastRefresh = Date.now();
    } catch {
      // Keep the previous inventory until the next refresh, including an empty first load.
    }
  }
}
