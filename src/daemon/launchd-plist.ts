/** Reads and renders macOS LaunchAgent plists for gateway service installs. */
import fs from "node:fs/promises";
import { asOptionalRecord, isStringRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../infra/gateway-shutdown-budget.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runExec } from "../process/exec.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnvironmentValueSource,
  GatewayServiceReadOptions,
} from "./service-types.js";

export { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS };

// launchd defaults to a 10s spawn throttle. Keep that default explicitly so
// crash loops back off instead of respawning every second while still allowing
// explicit kickstart restarts to take effect.
// launchd stores plist integer values in decimal; 0o077 renders as 63 (owner-only files).
export const LAUNCH_AGENT_POLICY = {
  RunAtLoad: true,
  KeepAlive: true,
  ExitTimeOut: LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  ProcessType: "Interactive",
  ThrottleInterval: 10,
  Umask: 0o077,
  StandardInPath: "/dev/null",
} as const;
export const LAUNCH_AGENT_ENV_WRAPPER_SHELL = "/bin/sh";

const plistEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

type ReadLaunchAgentProgramArgumentsOptions = GatewayServiceReadOptions & {
  expectedEnvironmentWrapperPath?: string;
  expectedEnvironmentFilePath?: string;
  generatedEnvironmentLabel?: string;
};

export function quoteLaunchAgentEnvironmentValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseGeneratedEnvValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) {
    return trimmed;
  }
  return trimmed.slice(1, -1).replaceAll("'\\''", "'");
}

function resolveSiblingGeneratedEnvFilePath(
  envFilePath: string,
  options?: ReadLaunchAgentProgramArgumentsOptions,
): string | undefined {
  const label = options?.generatedEnvironmentLabel?.trim();
  if (!label) {
    return undefined;
  }
  const serviceEnvMarker = "/service-env/";
  const markerIndex = envFilePath.replaceAll("\\", "/").lastIndexOf(serviceEnvMarker);
  if (markerIndex < 0) {
    return undefined;
  }
  // Custom state dirs can also contain service-env; use the generated env dir closest to the file.
  const serviceEnvDirEnd = markerIndex + serviceEnvMarker.length - 1;
  return `${envFilePath.slice(0, serviceEnvDirEnd)}/${label}.env`;
}

function isExpectedGeneratedEnvWrapperPair(
  wrapperPath: string | undefined,
  envFilePath: string | undefined,
  options?: ReadLaunchAgentProgramArgumentsOptions,
): boolean {
  if (!wrapperPath || !envFilePath) {
    return false;
  }
  if (!options) {
    return wrapperPath.endsWith("-env-wrapper.sh");
  }
  if (
    options.expectedEnvironmentWrapperPath &&
    options.expectedEnvironmentFilePath &&
    wrapperPath === options.expectedEnvironmentWrapperPath &&
    envFilePath === options.expectedEnvironmentFilePath
  ) {
    return true;
  }
  const label = options.generatedEnvironmentLabel?.trim();
  if (!label) {
    return false;
  }
  // Legacy/corrupted plists may preserve the label-derived wrapper name inside
  // a mangled service-env path. Still unwrap it so the next rewrite can repair.
  const normalizedWrapper = wrapperPath.replaceAll("\\", "/");
  const normalizedEnvFile = envFilePath.replaceAll("\\", "/");
  return (
    normalizedWrapper.includes("/service-env/") &&
    normalizedEnvFile.includes("/service-env/") &&
    normalizedWrapper.includes(`${label}-env-wrapper.sh`) &&
    normalizedEnvFile.includes(`${label}.env`)
  );
}

function resolveGeneratedEnvWrapperLayout(
  programArguments: string[],
  options?: ReadLaunchAgentProgramArgumentsOptions,
): { envFilePath: string; commandStartIndex: number } | null {
  if (programArguments[0] === LAUNCH_AGENT_ENV_WRAPPER_SHELL) {
    const wrapperPath = programArguments[1];
    const envFilePath = programArguments[2];
    if (isExpectedGeneratedEnvWrapperPair(wrapperPath, envFilePath, options) && envFilePath) {
      return { envFilePath, commandStartIndex: 3 };
    }
  }
  const wrapperPath = programArguments[0];
  const envFilePath = programArguments[1];
  if (isExpectedGeneratedEnvWrapperPair(wrapperPath, envFilePath, options) && envFilePath) {
    return { envFilePath, commandStartIndex: 2 };
  }
  return null;
}

async function readLaunchAgentEnvironmentFile(
  envFilePath: string | undefined,
  options?: ReadLaunchAgentProgramArgumentsOptions,
): Promise<Record<string, string>> {
  if (envFilePath === undefined) {
    return {};
  }
  let content = "";
  const candidateEnvFilePaths = options?.requireEffective
    ? [envFilePath]
    : Array.from(
        new Set(
          [
            envFilePath,
            resolveSiblingGeneratedEnvFilePath(envFilePath, options),
            options?.expectedEnvironmentFilePath,
          ].filter((candidate): candidate is string => Boolean(candidate)),
        ),
      );
  // Corrupted wrapper args can still point near the generated env dir. Try the
  // sibling canonical env file before giving up so repair rewrites retain env.
  for (const candidate of candidateEnvFilePaths) {
    try {
      content = await fs.readFile(candidate, "utf8");
      break;
    } catch (error) {
      if (options?.requireEffective) {
        throw error;
      }
      // Keep trying; mangled wrapper args may still have the canonical env file.
    }
  }
  if (!content) {
    return {};
  }
  const environment: Record<string, string> = {};
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] ?? "";
    const line = options?.requireEffective ? rawLine.trimStart() : rawLine.trim();
    if (!line.trim() || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
    if (!match) {
      if (options?.requireEffective) {
        throw new Error("Unsupported LaunchAgent environment syntax");
      }
      continue;
    }
    const key = match[1];
    let value = match[2];
    if (!key || value === undefined) {
      continue;
    }
    let parsedValue = parseGeneratedEnvValue(value);
    if (options?.requireEffective) {
      // The writer's quoted literals can span physical lines; retain their exact newline bytes.
      while (
        quoteLaunchAgentEnvironmentValue(parsedValue) !== value.trim() &&
        index + 1 < lines.length
      ) {
        value += `\n${lines[++index]}`;
        parsedValue = parseGeneratedEnvValue(value);
      }
      // Strict inspection accepts the writer's literal syntax, never shell expressions.
      if (quoteLaunchAgentEnvironmentValue(parsedValue) !== value.trim()) {
        throw new Error("Unsupported LaunchAgent environment value");
      }
    }
    environment[key] = parsedValue;
  }
  return environment;
}

const renderEnvDict = (env: Record<string, string | undefined> | undefined): string => {
  if (!env) {
    return "";
  }
  // An explicit empty NODE_OPTIONS blocks inherited supervisor preload/heap flags.
  const entries = Object.entries(env).filter(
    ([key, value]) => typeof value === "string" && (value.trim() || key === "NODE_OPTIONS"),
  );
  if (entries.length === 0) {
    return "";
  }
  const items = entries
    .map(
      ([key, value]) =>
        `\n    <key>${plistEscape(key)}</key>\n    <string>${plistEscape(value?.trim() ?? "")}</string>`,
    )
    .join("");
  return `\n    <key>EnvironmentVariables</key>\n    <dict>${items}\n    </dict>`;
};

export async function normalizeLaunchdPlistXml(
  contents: Uint8Array,
  timeoutMs = 5_000,
): Promise<string> {
  const { stdout } = await runExec("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
    input: contents,
    timeoutMs: Math.max(1, Math.min(timeoutMs, 5_000)),
    maxBuffer: 1024 * 1024,
    logOutput: false,
  });
  return stdout;
}

/** A completed native phase cannot renew the caller's monotonic inspection allowance. */
export function remainingLaunchdPlistReadTimeout(deadline: number | undefined): number | undefined {
  if (deadline === undefined) {
    return undefined;
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new Error("LaunchAgent inspection deadline expired.");
  }
  return remaining;
}

export async function decodeLaunchdPlistMetadata(
  contents: Uint8Array,
  timeoutMs?: number,
): Promise<Record<string, unknown> | undefined> {
  const deadline = performance.now() + Math.min(timeoutMs ?? 5_000, 5_000);
  const xml = await normalizeLaunchdPlistXml(contents, remainingLaunchdPlistReadTimeout(deadline));
  // Native XML escapes literal tag text; placeholders remain invalid command fields.
  const { stdout } = await runExec("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    input: xml.replace(/<(data|date)>[\s\S]*?<\/\1>/g, "<integer>0</integer>"),
    timeoutMs: remainingLaunchdPlistReadTimeout(deadline),
    maxBuffer: 1024 * 1024,
    logOutput: false,
  });
  remainingLaunchdPlistReadTimeout(deadline);
  return asOptionalRecord(JSON.parse(stdout));
}

export async function readLaunchAgentProgramArgumentsFromFile(
  plistPath: string,
  options?: ReadLaunchAgentProgramArgumentsOptions,
): Promise<GatewayServiceCommandConfig | null> {
  const deadline =
    options?.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
  try {
    const contents = await fs.readFile(plistPath).catch(async (error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        if (options?.requireEffective) {
          const absent = await fs.lstat(plistPath).then(
            () => false,
            (statError: unknown) => hasErrnoCode(statError, "ENOENT"),
          );
          if (!absent) {
            throw new Error("Unreadable LaunchAgent definition");
          }
        }
        return null;
      }
      throw error;
    });
    if (contents === null) {
      return null;
    }
    const plist = await decodeLaunchdPlistMetadata(
      contents,
      remainingLaunchdPlistReadTimeout(deadline),
    );
    const args = plist?.ProgramArguments;
    const workingDirectory = plist?.WorkingDirectory;
    const inlineEnvironment = plist?.EnvironmentVariables;
    if (
      !Array.isArray(args) ||
      !args.every((arg): arg is string => typeof arg === "string") ||
      (workingDirectory !== undefined && typeof workingDirectory !== "string") ||
      (inlineEnvironment !== undefined && !isStringRecord(inlineEnvironment))
    ) {
      throw new Error("Invalid LaunchAgent command fields");
    }
    const layout = resolveGeneratedEnvWrapperLayout(args, options);
    const fileEnvironment = await readLaunchAgentEnvironmentFile(layout?.envFilePath, options);
    const effectiveProgramArguments = layout ? args.slice(layout.commandStartIndex) : args;
    if (options?.requireEffective && !effectiveProgramArguments[0]) {
      throw new Error("Missing LaunchAgent command");
    }
    const environment = { ...inlineEnvironment, ...fileEnvironment };
    const environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource> = {};
    // Track source provenance so repair flows can tell inline plist env from the
    // generated env file and preserve both when they overlap.
    for (const key of Object.keys(environment)) {
      environmentValueSources[key] = !Object.hasOwn(fileEnvironment, key)
        ? "inline"
        : Object.hasOwn(inlineEnvironment ?? {}, key)
          ? "inline-and-file"
          : "file";
    }
    return {
      programArguments: effectiveProgramArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      ...(Object.keys(environmentValueSources).length > 0 ? { environmentValueSources } : {}),
      sourcePath: plistPath,
    };
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    if (options?.requireEffective) {
      throw new Error("Effective LaunchAgent service command could not be inspected.");
    }
    return null;
  }
}

export function buildLaunchAgentPlist({
  label,
  comment,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment,
}: {
  label: string;
  comment?: string;
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
    ? `\n    <key>WorkingDirectory</key>\n    <string>${plistEscape(workingDirectory)}</string>`
    : "";
  const commentXml = comment?.trim()
    ? `\n    <key>Comment</key>\n    <string>${plistEscape(comment.trim())}</string>`
    : "";
  const envXml = renderEnvDict(environment);
  const policyXml = Object.entries(LAUNCH_AGENT_POLICY)
    .map(([key, value]) => {
      const type = typeof value === "number" ? "integer" : "string";
      const xml =
        typeof value === "boolean"
          ? `<${value}/>`
          : `<${type}>${plistEscape(String(value))}</${type}>`;
      return `    <key>${key}</key>\n    ${xml}`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${plistEscape(label)}</string>\n    ${commentXml}\n${policyXml}\n    <key>ProgramArguments</key>\n    <array>${argsXml}\n    </array>\n    ${workingDirXml}\n    <key>StandardOutPath</key>\n    <string>${plistEscape(stdoutPath)}</string>\n    <key>StandardErrorPath</key>\n    <string>${plistEscape(stderrPath)}</string>${envXml}\n  </dict>\n</plist>\n`;
}
