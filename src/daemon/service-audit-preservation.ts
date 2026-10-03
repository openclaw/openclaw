import fs from "node:fs";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseNodeOptionsEnvVar } from "../infra/node-options.js";
import { resolveGatewayServiceDescription } from "./constants.js";
import { readServiceHeapExecArgv, resolveGatewayHeapNodeOptions } from "./gateway-heap.js";
import type {
  GatewayServiceCommand,
  GatewayServiceExpectedCommand,
  ServiceDefinitionDrift,
} from "./service-audit-types.js";
import { resolveServiceEntrypointIndex } from "./service-layout.js";
import { readManagedServiceEnvKeysFromEnvironment } from "./service-managed-env.js";
import { normalizeServicePathEntry } from "./service-path-policy.js";
import { resolveManagedGatewayServiceCommand, type GatewayServiceEnv } from "./service-types.js";

export function serviceDefinitionPreserved(
  key: string,
  sourcePath?: string,
): ServiceDefinitionDrift {
  return { kind: "preserved", key, sourcePath, message: `Custom ${key}; not changed.` };
}

export function serviceDefinitionUnknown(
  key: string,
  reason: string,
  sourcePath?: string,
): ServiceDefinitionDrift {
  return {
    kind: "unknown-edit",
    key,
    reason,
    sourcePath,
    message: `Gateway service ${key}: ${reason}`,
  };
}

export function isInstallerServiceDescription(value: unknown, env: GatewayServiceEnv): boolean {
  const current = resolveGatewayServiceDescription({ env });
  if (value === undefined || value === current) {
    return true;
  }
  const prefix = current.endsWith(")") ? `${current.slice(0, -1)}, v` : `${current} (v`;
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    /^\d{4}\.\d+\.\d+(?:[-+][\w.-]+)?\)$/u.test(value.slice(prefix.length))
  );
}

function preservedArguments(argv: readonly string[]): string[] | undefined {
  const entrypoint = resolveServiceEntrypointIndex(argv);
  if (entrypoint === undefined) {
    return undefined;
  }
  const native = argv.slice(1, entrypoint);
  const retained: string[] = [];
  for (let index = 0; index < native.length; index++) {
    const arg = native[index]!;
    const heap = resolveGatewayHeapNodeOptions(
      arg.includes("=") ? arg : `${arg} ${native[index + 1] ?? ""}`,
    );
    if (heap.startsWith(`${arg.split("=")[0]!.replaceAll("_", "-")}=`)) {
      index += arg.includes("=") ? 0 : 1;
    } else {
      retained.push(arg);
    }
  }
  return [
    ...retained,
    ...argv
      .slice(entrypoint + 1)
      .filter(
        (arg, index, args) =>
          arg !== "--allow-unconfigured" &&
          arg !== "--port" &&
          !arg.startsWith("--port=") &&
          (args[index - 1] !== "--port" || arg.startsWith("--")),
      ),
    ...readServiceHeapExecArgv(argv),
  ];
}

function retains(
  current: readonly string[] | undefined,
  expected: readonly string[] | undefined,
): boolean {
  if (!current || !expected) {
    return false;
  }
  let index = 0;
  for (const value of expected) {
    if (value === current[index]) {
      index++;
    }
  }
  return index === current.length;
}

function isLegacyDarwinInstallerPath(command: NonNullable<GatewayServiceCommand>): boolean {
  const home = command.environment?.HOME;
  const runtime = command.programArguments[0];
  if (
    command.environmentValueSources?.PATH !== "file" ||
    !home ||
    !path.posix.isAbsolute(home) ||
    !runtime ||
    !path.posix.isAbsolute(runtime)
  ) {
    return false;
  }
  // v2026.4.29's default template, before 85ce75c005a canonicalized Darwin
  // PATH. The generated-file header alone cannot establish an unedited value.
  const optionalDirectories = [
    ".volta/bin",
    ".asdf/shims",
    ".bun/bin",
    "Library/Application Support/fnm/aliases/default/bin",
    ".fnm/aliases/default/bin",
    "Library/pnpm",
    ".local/share/pnpm",
  ].map((directory) => `${home}/${directory}`);
  const legacy = [
    path.posix.dirname(runtime),
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/bin`,
    ...optionalDirectories.slice(0, 3).filter((directory) => fs.existsSync(directory)),
    `${home}/.nix-profile/bin`,
    ...optionalDirectories.slice(3).filter((directory) => fs.existsSync(directory)),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return command.environment?.PATH === [...new Set(legacy)].join(":");
}

function describeEnvironmentValue(key: string, value: string | undefined): string {
  if (value === undefined) {
    return "<absent>";
  }
  // Arbitrary operator environment values may be credentials, regardless of key name.
  if (
    key !== "PATH" &&
    !(key === "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS" && /^\d+$/u.test(value))
  ) {
    return "<redacted>";
  }
  const display = JSON.stringify(value);
  return display.length > 240 ? `${truncateUtf16Safe(display, 240)}…` : display;
}

/** Compare prepared installer output; reporting-only audit never constructs a rewrite plan. */
export function auditGatewayInstallPreservation(
  command: GatewayServiceCommand,
  expected: GatewayServiceExpectedCommand,
  platform: NodeJS.Platform,
  findings: ServiceDefinitionDrift[],
): void {
  const current = resolveManagedGatewayServiceCommand(command);
  if (!current) {
    return;
  }
  const unknown = (key: string, detail = "") =>
    findings.push(
      serviceDefinitionUnknown(
        key,
        `The installer would discard or change an operator setting.${detail}`,
        command?.sourcePath,
      ),
    );
  if (
    !retains(
      preservedArguments(current.programArguments),
      preservedArguments(expected.programArguments),
    )
  ) {
    unknown("ProgramArguments");
  }
  if (
    current.workingDirectory !== undefined &&
    (expected.workingDirectory === undefined ||
      normalizeServicePathEntry(current.workingDirectory, platform) !==
        normalizeServicePathEntry(expected.workingDirectory, platform))
  ) {
    unknown("WorkingDirectory");
  }
  const normalize = (key: string) => (platform === "win32" ? key.toUpperCase() : key);
  const next = new Map(
    Object.entries(expected.environment ?? {}).map(([key, value]) => [normalize(key), value]),
  );
  const managed = readManagedServiceEnvKeysFromEnvironment(current.environment);
  for (const [key, value] of Object.entries(current.environment ?? {})) {
    const upper = key.toUpperCase();
    const replacement = next.get(normalize(key));
    if (platform === "win32" && upper === "PATH") {
      unknown(`Environment.${key}`);
      continue;
    }
    if (
      replacement === value ||
      managed.has(upper) ||
      upper === "OPENCLAW_SERVICE_MANAGED_ENV_KEYS" ||
      upper === "OPENCLAW_GATEWAY_PORT" ||
      (upper === "OPENCLAW_SERVICE_VERSION" && /^\d{4}\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(value))
    ) {
      continue;
    }
    if (upper === "PATH" && replacement !== undefined) {
      if (platform === "darwin" && isLegacyDarwinInstallerPath(current)) {
        continue;
      }
      const paths = (text: string) =>
        text
          .split(platform === "win32" ? ";" : ":")
          .map((part) => normalizeServicePathEntry(part, platform));
      if (retains(paths(value), paths(replacement))) {
        continue;
      }
    }
    if (upper === "NODE_OPTIONS" && replacement !== undefined) {
      const args = (text: string) => {
        const tokens = parseNodeOptionsEnvVar(text);
        return tokens
          ? preservedArguments(["node", ...tokens, "/service/index.js", "gateway"])
          : undefined;
      };
      if (retains(args(value), args(replacement))) {
        continue;
      }
    }
    unknown(
      `Environment.${key}`,
      ` Current: ${describeEnvironmentValue(key, value)}; installer: ${describeEnvironmentValue(key, replacement)}.`,
    );
  }
  const expectedManaged = readManagedServiceEnvKeysFromEnvironment(expected.environment);
  const effective = new Set(Object.keys(command?.environment ?? {}).map(normalize));
  for (const [key, value] of Object.entries(expected.environment ?? {})) {
    if (
      value === undefined ||
      !expectedManaged.has(key.toUpperCase()) ||
      effective.has(normalize(key))
    ) {
      continue;
    }
    const installer = describeEnvironmentValue(key, value);
    findings.push({
      kind: "outdated",
      key: `Environment.${key}`,
      current: null,
      expected: installer,
      sourcePath: command?.sourcePath,
      message: `Gateway service Environment.${key} is missing. Current: <absent>; installer: ${installer}.`,
    });
  }
}
