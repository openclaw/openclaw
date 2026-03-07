import fs from "node:fs/promises";
import path from "node:path";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "./constants.js";
import { execSchtasks } from "./schtasks-exec.js";

export type ExtraGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
  scope: "user" | "system";
  marker?: "openclaw" | "clawdbot" | "moltbot";
  legacy?: boolean;
};

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

const EXTRA_MARKERS = ["openclaw", "clawdbot", "moltbot"] as const;

export function renderGatewayServiceCleanupHints(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string[] {
  const profile = env.OPENCLAW_PROFILE;
  switch (process.platform) {
    case "darwin": {
      const label = resolveGatewayLaunchAgentLabel(profile);
      return [`launchctl bootout gui/$UID/${label}`, `rm ~/Library/LaunchAgents/${label}.plist`];
    }
    case "linux": {
      const unit = resolveGatewaySystemdServiceName(profile);
      return [
        `systemctl --user disable --now ${unit}.service`,
        `rm ~/.config/systemd/user/${unit}.service`,
      ];
    }
    case "win32": {
      const task = resolveGatewayWindowsTaskName(profile);
      return [`schtasks /Delete /TN "${task}" /F`];
    }
    default:
      return [];
  }
}

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    throw new Error("Missing HOME");
  }
  return home;
}

type Marker = (typeof EXTRA_MARKERS)[number];

type PathChar = string;

const PATH_BOUNDARY_CHARS = new Set<PathChar>(["", "/", "\\", "\n", "\t", " ", '"', "'", ":", "="]);

function isBoundaryChar(char: PathChar | undefined): boolean {
  return PATH_BOUNDARY_CHARS.has(char ?? "");
}

function scrubHomePath(lower: string, home: string): string {
  if (!home) {
    return lower;
  }
  const homeLower = home.toLowerCase();
  let out = "";
  let idx = 0;
  while (idx < lower.length) {
    const hit = lower.indexOf(homeLower, idx);
    if (hit === -1) {
      out += lower.slice(idx);
      break;
    }
    const before = hit === 0 ? "" : lower[hit - 1];
    const after = lower[hit + homeLower.length] ?? "";
    const isStartBoundary = hit === 0 || isBoundaryChar(before);
    const isEndBoundary = isBoundaryChar(after);
    if (isStartBoundary && isEndBoundary) {
      out += lower.slice(idx, hit);
      idx = hit + homeLower.length;
      continue;
    }
    out += lower.slice(idx, hit + homeLower.length);
    idx = hit + homeLower.length;
  }
  return out;
}

function detectMarker(content: string, env: Record<string, string | undefined>): Marker | null {
  const lower = content.toLowerCase();
  let scrubbed = lower;
  try {
    const home = resolveHomeDir(env).toLowerCase();
    if (home) {
      scrubbed = scrubHomePath(scrubbed, home);
      const windowsHome = home.replaceAll("/", "\\");
      if (windowsHome !== home) {
        scrubbed = scrubHomePath(scrubbed, windowsHome);
      }
    }
  } catch {}
  for (const marker of EXTRA_MARKERS) {
    if (scrubbed.includes(marker)) {
      return marker;
    }
  }
  return null;
}

function hasGatewayServiceMarker(content: string): boolean {
  const lower = content.toLowerCase();
  const markerKeys = ["openclaw_service_marker"];
  const kindKeys = ["openclaw_service_kind"];
  const markerValues = [GATEWAY_SERVICE_MARKER.toLowerCase()];
  const hasMarkerKey = markerKeys.some((key) => lower.includes(key));
  const hasKindKey = kindKeys.some((key) => lower.includes(key));
  const hasMarkerValue = markerValues.some((value) => lower.includes(value));
  return (
    hasMarkerKey &&
    hasKindKey &&
    hasMarkerValue &&
    lower.includes(GATEWAY_SERVICE_KIND.toLowerCase())
  );
}

function isOpenClawGatewayLaunchdService(label: string, contents: string): boolean {
  if (hasGatewayServiceMarker(contents)) {
    return true;
  }
  const lowerContents = contents.toLowerCase();
  if (!lowerContents.includes("gateway")) {
    return false;
  }
  return label.startsWith("ai.openclaw.");
}

function isOpenClawGatewaySystemdService(name: string, contents: string): boolean {
  if (hasGatewayServiceMarker(contents)) {
    return true;
  }
  if (!name.startsWith("openclaw-gateway")) {
    return false;
  }
  return contents.toLowerCase().includes("gateway");
}

function isOpenClawGatewayTaskName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const defaultName = resolveGatewayWindowsTaskName().toLowerCase();
  return normalized === defaultName || normalized.startsWith("openclaw gateway");
}

function tryExtractPlistLabel(contents: string): string | null {
  const match = contents.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/i);
  if (!match) {
    return null;
  }
  return match[1]?.trim() || null;
}

function isIgnoredLaunchdLabel(label: string): boolean {
  return label === resolveGatewayLaunchAgentLabel();
}

function isIgnoredSystemdName(name: string): boolean {
  return name === resolveGatewaySystemdServiceName();
}

function isLegacyLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return lower.includes("clawdbot") || lower.includes("moltbot");
}

async function readDirEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function readUtf8File(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

type ServiceFileEntry = {
  entry: string;
  name: string;
  fullPath: string;
  contents: string;
};

async function collectServiceFiles(params: {
  dir: string;
  extension: string;
  isIgnoredName: (name: string) => boolean;
}): Promise<ServiceFileEntry[]> {
  const out: ServiceFileEntry[] = [];
  const entries = await readDirEntries(params.dir);
  for (const entry of entries) {
    if (!entry.endsWith(params.extension)) {
      continue;
    }
    const name = entry.slice(0, -params.extension.length);
    if (params.isIgnoredName(name)) {
      continue;
    }
    const fullPath = path.join(params.dir, entry);
    const contents = await readUtf8File(fullPath);
    if (contents === null) {
      continue;
    }
    out.push({ entry, name, fullPath, contents });
  }
  return out;
}

async function scanLaunchdDir(params: {
  dir: string;
  scope: "user" | "system";
  env: Record<string, string | undefined>;
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".plist",
    isIgnoredName: isIgnoredLaunchdLabel,
  });

  for (const { name: labelFromName, fullPath, contents } of candidates) {
    const marker = detectMarker(contents, params.env);
    const label = tryExtractPlistLabel(contents) ?? labelFromName;
    if (!marker) {
      const legacyLabel = isLegacyLabel(labelFromName) || isLegacyLabel(label);
      if (!legacyLabel) {
        continue;
      }
      results.push({
        platform: "darwin",
        label,
        detail: `plist: ${fullPath}`,
        scope: params.scope,
        marker: isLegacyLabel(label) ? "clawdbot" : "moltbot",
        legacy: true,
      });
      continue;
    }
    if (isIgnoredLaunchdLabel(label)) {
      continue;
    }
    if (marker === "openclaw" && isOpenClawGatewayLaunchdService(label, contents)) {
      continue;
    }
    results.push({
      platform: "darwin",
      label,
      detail: `plist: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw" || isLegacyLabel(label),
    });
  }

  return results;
}

async function scanSystemdDir(params: {
  dir: string;
  scope: "user" | "system";
  env: Record<string, string | undefined>;
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".service",
    isIgnoredName: isIgnoredSystemdName,
  });

  for (const { entry, name, fullPath, contents } of candidates) {
    const marker = detectMarker(contents, params.env);
    if (!marker) {
      continue;
    }
    if (marker === "openclaw" && isOpenClawGatewaySystemdService(name, contents)) {
      continue;
    }
    results.push({
      platform: "linux",
      label: entry,
      detail: `unit: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw",
    });
  }

  return results;
}

type ScheduledTaskInfo = {
  name: string;
  taskToRun?: string;
};

function parseSchtasksList(output: string): ScheduledTaskInfo[] {
  const tasks: ScheduledTaskInfo[] = [];
  let current: ScheduledTaskInfo | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        tasks.push(current);
        current = null;
      }
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) {
      continue;
    }
    if (key === "taskname") {
      if (current) {
        tasks.push(current);
      }
      current = { name: value };
      continue;
    }
    if (!current) {
      continue;
    }
    if (key === "task to run") {
      current.taskToRun = value;
    }
  }

  if (current) {
    tasks.push(current);
  }
  return tasks;
}

export const __test__ = {
  detectMarker,
  scrubHomePath,
};

export async function findExtraGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions = {},
): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const seen = new Set<string>();
  const push = (svc: ExtraGatewayService) => {
    const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(svc);
  };

  if (process.platform === "darwin") {
    try {
      const home = resolveHomeDir(env);
      const userDir = path.join(home, "Library", "LaunchAgents");
      for (const svc of await scanLaunchdDir({
        dir: userDir,
        scope: "user",
        env,
      })) {
        push(svc);
      }
      if (opts.deep) {
        for (const svc of await scanLaunchdDir({
          dir: path.join(path.sep, "Library", "LaunchAgents"),
          scope: "system",
          env,
        })) {
          push(svc);
        }
        for (const svc of await scanLaunchdDir({
          dir: path.join(path.sep, "Library", "LaunchDaemons"),
          scope: "system",
          env,
        })) {
          push(svc);
        }
      }
    } catch {
      return results;
    }
    return results;
  }

  if (process.platform === "linux") {
    try {
      const home = resolveHomeDir(env);
      const userDir = path.join(home, ".config", "systemd", "user");
      for (const svc of await scanSystemdDir({
        dir: userDir,
        scope: "user",
        env,
      })) {
        push(svc);
      }
      if (opts.deep) {
        for (const dir of [
          "/etc/systemd/system",
          "/usr/lib/systemd/system",
          "/lib/systemd/system",
        ]) {
          for (const svc of await scanSystemdDir({
            dir,
            scope: "system",
            env,
          })) {
            push(svc);
          }
        }
      }
    } catch {
      return results;
    }
    return results;
  }

  if (process.platform === "win32") {
    if (!opts.deep) {
      return results;
    }
    const res = await execSchtasks(["/Query", "/FO", "LIST", "/V"]);
    if (res.code !== 0) {
      return results;
    }
    const tasks = parseSchtasksList(res.stdout);
    for (const task of tasks) {
      const name = task.name.trim();
      if (!name) {
        continue;
      }
      if (isOpenClawGatewayTaskName(name)) {
        continue;
      }
      const marker = detectMarker(`${name}\n${task.taskToRun ?? ""}`, env);
      if (!marker) {
        continue;
      }
      push({
        platform: "win32",
        label: name,
        detail: task.taskToRun ? `task: ${name}, run: ${task.taskToRun}` : name,
        scope: "system",
        marker,
        legacy: marker !== "openclaw",
      });
    }
    return results;
  }

  return results;
}
