import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveGatewaySystemdServiceName, resolveNodeLaunchAgentLabel } from "./constants.js";
import { detectMarkerLineWithGateway, hasGatewayServiceMarker } from "./inspect-markers.js";
import { parseSystemdInlineEnvironment } from "./systemd-unit.js";

export type ExtraGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
  sourcePath?: string;
  scope: "user" | "system";
  marker?: "openclaw" | "clawdbot";
  legacy?: boolean;
  /** Exact Startup definition; a task label cannot identify this native owner. */
  windowsStartupEntry?: string;
};

type ScannedGatewayService = ExtraGatewayService & { extra: boolean; managedGateway: boolean };

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

export type ServiceFileInspectionError = { source: string; message: string };

export async function collectServiceFiles(params: {
  dir: string;
  extension: string;
  isPotentialName: (name: string) => boolean;
  errors?: ServiceFileInspectionError[];
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

export async function scanSystemdDir(params: {
  dir: string;
  scope: "user" | "system";
  selectedName?: string;
  errors?: ServiceFileInspectionError[];
}): Promise<ScannedGatewayService[]> {
  const results: ScannedGatewayService[] = [];
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".service",
    isPotentialName: (name) => isPotentialGatewayServiceName(name, "linux", params.selectedName),
    errors: params.errors,
  });

  for (const { entry, name, fullPath, contents: bytes } of candidates) {
    const contents = bytes.toString("utf8");
    const serviceMarker = hasGatewayServiceMarker(parseSystemdInlineEnvironment(contents));
    const marker = serviceMarker ? "openclaw" : detectMarkerLineWithGateway(contents);
    if (!marker) {
      continue;
    }
    results.push({
      platform: "linux",
      label: entry,
      detail: `unit: ${fullPath}`,
      sourcePath: fullPath,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw",
      managedGateway: marker === "openclaw",
      extra:
        name !== resolveGatewaySystemdServiceName() &&
        !(
          marker === "openclaw" &&
          !isLegacyLabel(name) &&
          params.scope === "user" &&
          name === params.selectedName
        ) &&
        !serviceMarker &&
        !(marker === "openclaw" && name.startsWith("openclaw-gateway")),
    });
  }

  return results;
}
