import type { SkillEligibilityContext, SkillEntry } from "../agents/skills.js";
import { loadWorkspaceSkillEntries } from "../agents/skills.js";
import { bumpSkillsSnapshotVersion } from "../agents/skills/refresh.js";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { execDockerRaw } from "../agents/sandbox/docker.js";
import { DEFAULT_SANDBOX_IMAGE } from "../agents/sandbox/constants.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/skills-sandbox");

let cachedBins: Set<string> | null = null;
let cachedImage: string | null = null;

/**
 * Collect all bins required by skills that could run in the sandbox.
 */
function collectRequiredBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    for (const bin of entry.metadata?.requires?.bins ?? []) {
      if (bin.trim()) bins.add(bin.trim());
    }
    for (const bin of entry.metadata?.requires?.anyBins ?? []) {
      if (bin.trim()) bins.add(bin.trim());
    }
  }
  return [...bins];
}

function buildBinProbeScript(bins: string[]): string {
  const escaped = bins.map((b) => `'${b.replace(/'/g, `'\\''`)}'`).join(" ");
  return `for b in ${escaped}; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; fi; done`;
}

/**
 * Try to probe bins inside a running sandbox container first (cheapest).
 * Falls back to `docker run --rm` on the sandbox image.
 */
async function probeSandboxBins(
  image: string,
  bins: string[],
  containerName?: string,
): Promise<string[]> {
  if (bins.length === 0) return [];

  const script = buildBinProbeScript(bins);

  // Try running container first (no startup cost)
  if (containerName) {
    try {
      const result = await execDockerRaw(
        ["exec", "-i", containerName, "sh", "-c", script],
        { allowFailure: true },
      );
      if (result.code === 0) {
        return result.stdout
          .toString()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
      }
    } catch {
      // container not running, fall through to image probe
    }
  }

  // Fall back to image probe
  try {
    const result = await execDockerRaw(
      ["run", "--rm", "--entrypoint", "sh", image, "-c", script],
      { allowFailure: true },
    );
    if (result.code === 0) {
      return result.stdout
        .toString()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
  } catch (err) {
    log.warn(`sandbox bin probe failed for image ${image}: ${String(err)}`);
  }

  return [];
}

/**
 * Resolve the sandbox image from config (agent-level or global default).
 */
function resolveSandboxImage(cfg: OpenClawConfig, agentId?: string): string | undefined {
  const sandboxCfg = resolveSandboxConfigForAgent(cfg, agentId);
  if (sandboxCfg.mode === "off") return undefined;
  return sandboxCfg.docker?.image ?? DEFAULT_SANDBOX_IMAGE;
}

/**
 * Refresh the cached set of binaries available in the sandbox image.
 * Call this on gateway startup and when sandbox config changes.
 */
export async function refreshSandboxBinsCache(cfg: OpenClawConfig, agentId?: string) {
  const image = resolveSandboxImage(cfg, agentId);
  if (!image) {
    cachedBins = null;
    cachedImage = null;
    return;
  }

  const workspaceDirs = listAgentWorkspaceDirs(cfg);
  const allBins = new Set<string>();
  for (const dir of workspaceDirs) {
    const entries = loadWorkspaceSkillEntries(dir, { config: cfg });
    for (const bin of collectRequiredBins(entries)) {
      allBins.add(bin);
    }
  }
  if (allBins.size === 0) {
    cachedBins = new Set();
    cachedImage = image;
    return;
  }

  const found = await probeSandboxBins(image, [...allBins]);
  const nextBins = new Set(found);
  const changed = cachedImage !== image || !areSetsEqual(cachedBins, nextBins);
  cachedBins = nextBins;
  cachedImage = image;
  if (changed) {
    bumpSkillsSnapshotVersion({ reason: "sandbox-bins" });
  }
}

function areSetsEqual(a: Set<string> | null, b: Set<string>): boolean {
  if (!a) return false;
  if (a.size !== b.size) return false;
  for (const v of b) { if (!a.has(v)) return false; }
  return true;
}

export function getSandboxSkillEligibility(): SkillEligibilityContext["sandbox"] | undefined {
  if (!cachedBins || cachedBins.size === 0) return undefined;
  return {
    hasBin: (bin) => cachedBins!.has(bin),
    hasAnyBin: (bins) => bins.some((b) => cachedBins!.has(b)),
    image: cachedImage ?? undefined,
  };
}
