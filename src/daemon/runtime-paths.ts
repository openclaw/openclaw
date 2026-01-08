import fs from "node:fs/promises";
import path from "node:path";

const VERSION_MANAGER_MARKERS = [
  "/.nvm/",
  "/.fnm/",
  "/.volta/",
  "/.asdf/",
  "/.n/",
  "/.nodenv/",
  "/.nodebrew/",
  "/nvs/",
];

function normalizeForCompare(input: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(input);
  if (platform === "win32") {
    return normalized.replaceAll("\\", "/").toLowerCase();
  }
  return normalized;
}

function buildSystemNodeCandidates(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  }
  if (platform === "linux") {
    return ["/usr/local/bin/node", "/usr/bin/node"];
  }
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      path.join(programFiles, "nodejs", "node.exe"),
      path.join(programFilesX86, "nodejs", "node.exe"),
    ];
  }
  return [];
}

export function isVersionManagedNodePath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeForCompare(nodePath, platform);
  return VERSION_MANAGER_MARKERS.some((marker) => normalized.includes(marker));
}

export function isSystemNodePath(
  nodePath: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeForCompare(nodePath, platform);
  return buildSystemNodeCandidates(env, platform).some((candidate) => {
    const normalizedCandidate = normalizeForCompare(candidate, platform);
    return normalized === normalizedCandidate;
  });
}

export async function resolveSystemNodePath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const candidates = buildSystemNodeCandidates(env, platform);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep going
    }
  }
  return null;
}

export async function resolvePreferredNodePath(params: {
  env?: Record<string, string | undefined>;
  runtime?: string;
}): Promise<string | undefined> {
  if (params.runtime !== "node") return undefined;
  const systemNode = await resolveSystemNodePath(params.env);
  return systemNode ?? undefined;
}
