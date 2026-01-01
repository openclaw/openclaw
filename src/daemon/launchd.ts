import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { GATEWAY_LAUNCH_AGENT_LABEL } from "./constants.js";

const execFileAsync = promisify(execFile);

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error("Missing HOME");
  return home;
}

export function resolveLaunchAgentPlistPath(
  env: Record<string, string | undefined>,
): string {
  const home = resolveHomeDir(env);
  return path.join(
    home,
    "Library",
    "LaunchAgents",
    `${GATEWAY_LAUNCH_AGENT_LABEL}.plist`,
  );
}

export function resolveGatewayLogPaths(
  env: Record<string, string | undefined>,
): {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const home = resolveHomeDir(env);
  const logDir = path.join(home, ".clawdis", "logs");
  return {
    logDir,
    stdoutPath: path.join(logDir, "gateway.log"),
    stderrPath: path.join(logDir, "gateway.err.log"),
  };
}

function plistEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function renderEnvDict(
  env: Record<string, string | undefined> | undefined,
): string {
  if (!env) return "";
  const entries = Object.entries(env).filter(
    ([, value]) => typeof value === "string" && value.trim(),
  );
  if (entries.length === 0) return "";
  const items = entries
    .map(
      ([key, value]) => `
    <key>${plistEscape(key)}</key>
    <string>${plistEscape(value?.trim() ?? "")}</string>`,
    )
    .join("");
  return `
    <key>EnvironmentVariables</key>
    <dict>${items}
    </dict>`;
}

export async function readLaunchAgentProgramArguments(
  env: Record<string, string | undefined>,
): Promise<{ programArguments: string[]; workingDirectory?: string } | null> {
  const plistPath = resolveLaunchAgentPlistPath(env);
  try {
    const plist = await fs.readFile(plistPath, "utf8");
    const programMatch = plist.match(
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i,
    );
    if (!programMatch) return null;
    const args = Array.from(
      programMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/gi),
    ).map((match) => plistUnescape(match[1] ?? "").trim());
    const workingDirMatch = plist.match(
      /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/i,
    );
    const workingDirectory = workingDirMatch
      ? plistUnescape(workingDirMatch[1] ?? "").trim()
      : "";
    return {
      programArguments: args.filter(Boolean),
      ...(workingDirectory ? { workingDirectory } : {}),
    };
  } catch {
    return null;
  }
}

export function buildLaunchAgentPlist({
  label = GATEWAY_LAUNCH_AGENT_LABEL,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment,
}: {
  label?: string;
  programArguments: string[];
  workingDirectory?: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string | undefined>;
}): string {
  const argsXml = programArguments
    .map((arg) => `\n      <string>${plistEscape(arg)}</string>`)
    .join("");
  const workingDirXml = workingDirectory
    ? `
    <key>WorkingDirectory</key>
    <string>${plistEscape(workingDirectory)}</string>`
    : "";
  const envXml = renderEnvDict(environment);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${plistEscape(label)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProgramArguments</key>
    <array>${argsXml}
    </array>
    ${workingDirXml}
    <key>StandardOutPath</key>
    <string>${plistEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(stderrPath)}</string>${envXml}
  </dict>
</plist>
`;
}

async function execLaunchctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, {
      encoding: "utf8",
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : typeof e.message === "string"
            ? e.message
            : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") return "gui/501";
  return `gui/${process.getuid()}`;
}

export async function isLaunchAgentLoaded(): Promise<boolean> {
  const domain = resolveGuiDomain();
  const label = GATEWAY_LAUNCH_AGENT_LABEL;
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  return res.code === 0;
}

export async function uninstallLaunchAgent({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const domain = resolveGuiDomain();
  const plistPath = resolveLaunchAgentPlistPath(env);
  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);

  try {
    await fs.access(plistPath);
  } catch {
    stdout.write(`LaunchAgent not found at ${plistPath}\n`);
    return;
  }

  const home = resolveHomeDir(env);
  const trashDir = path.join(home, ".Trash");
  const dest = path.join(trashDir, `${GATEWAY_LAUNCH_AGENT_LABEL}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(plistPath, dest);
    stdout.write(`Moved LaunchAgent to Trash: ${dest}\n`);
  } catch {
    stdout.write(`LaunchAgent remains at ${plistPath} (could not move)\n`);
  }
}

export async function installLaunchAgent({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): Promise<{ plistPath: string }> {
  const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
  await fs.mkdir(logDir, { recursive: true });

  const plistPath = resolveLaunchAgentPlistPath(env);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });

  const plist = buildLaunchAgentPlist({
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
  await fs.writeFile(plistPath, plist, "utf8");

  const domain = resolveGuiDomain();
  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  if (boot.code !== 0) {
    throw new Error(
      `launchctl bootstrap failed: ${boot.stderr || boot.stdout}`.trim(),
    );
  }
  await execLaunchctl(["enable", `${domain}/${GATEWAY_LAUNCH_AGENT_LABEL}`]);
  await execLaunchctl([
    "kickstart",
    "-k",
    `${domain}/${GATEWAY_LAUNCH_AGENT_LABEL}`,
  ]);

  stdout.write(`Installed LaunchAgent: ${plistPath}\n`);
  stdout.write(`Logs: ${stdoutPath}\n`);
  return { plistPath };
}

export async function restartLaunchAgent({
  stdout,
}: {
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const domain = resolveGuiDomain();
  const label = GATEWAY_LAUNCH_AGENT_LABEL;
  const res = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  if (res.code !== 0) {
    throw new Error(
      `launchctl kickstart failed: ${res.stderr || res.stdout}`.trim(),
    );
  }
  stdout.write(`Restarted LaunchAgent: ${domain}/${label}\n`);
}
