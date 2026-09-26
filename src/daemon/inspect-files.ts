import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveNodeLaunchAgentLabel } from "./constants.js";

export async function readServiceFile(filePath: string): Promise<Buffer | null> {
  return fs.readFile(filePath).catch(() => null);
}

export function isPotentialGatewayServiceName(
  name: string,
  platform: "darwin" | "linux",
  selected?: string,
): boolean {
  return (
    name === selected ||
    (platform === "darwin"
      ? (name.startsWith("ai.openclaw.") && name !== resolveNodeLaunchAgentLabel()) ||
        /clawdbot.*gateway/.test(name)
      : /^(?:openclaw|clawdbot)(?:$|@|-gateway(?:$|[-.@]))/.test(name))
  );
}

type ServiceFileEntry = {
  entry: string;
  name: string;
  fullPath: string;
  contents: Buffer;
};

export async function collectServiceFiles(params: {
  dir: string;
  extension: string;
  isPotentialName: (name: string) => boolean;
  errors?: Array<{ source: string; message: string }>;
}): Promise<ServiceFileEntry[]> {
  const out: ServiceFileEntry[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(params.dir);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      params.errors?.push({ source: params.dir, message: "Service path could not be inspected." });
    }
    return out;
  }
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(params.extension)) {
      continue;
    }
    const name = entry.slice(0, -params.extension.length);
    const fullPath = path.join(params.dir, entry);
    let contents: Buffer;
    try {
      contents = await fs.readFile(fullPath);
    } catch {
      if (params.isPotentialName(name)) {
        params.errors?.push({ source: fullPath, message: "Service path could not be inspected." });
      }
      continue;
    }
    out.push({ entry, name, fullPath, contents });
  }
  return out;
}

export function isLegacyLabel(label: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(label);
  return lower.includes("clawdbot");
}
