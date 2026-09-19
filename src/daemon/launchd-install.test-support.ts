import { PassThrough } from "node:stream";
import type {
  installLaunchAgent as installLaunchAgentImpl,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";

export const defaultProgramArguments = ["node", "-e", "process.exit(0)"];

export function createDefaultLaunchdEnv(): Record<string, string | undefined> {
  return {
    HOME: "/Users/test",
    OPENCLAW_PROFILE: "default",
  };
}

export function createLaunchdEnvWithGatewayPort(port: string): Record<string, string | undefined> {
  return { ...createDefaultLaunchdEnv(), OPENCLAW_GATEWAY_PORT: port };
}

export function createTestLaunchAgentPlist(params: {
  label: string;
  programArguments: string[];
  environment?: Record<string, string>;
}): string {
  const argsXml = params.programArguments.map((arg) => `      <string>${arg}</string>`).join("\n");
  const envXml = params.environment
    ? [
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        ...Object.entries(params.environment).flatMap(([key, value]) => [
          `      <key>${key}</key>`,
          `      <string>${value}</string>`,
        ]),
        "    </dict>",
      ].join("\n")
    : "";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${params.label}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argsXml,
    "    </array>",
    envXml,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

type LaunchAgentInstallFixture = Parameters<typeof installLaunchAgentImpl>[0];
type LaunchAgentInstallOverrides = Omit<
  LaunchAgentInstallFixture,
  "env" | "stdout" | "programArguments"
>;

export function launchAgentFixture(
  env: LaunchAgentInstallFixture["env"],
  programArguments: string[],
  overrides: LaunchAgentInstallOverrides = {},
): LaunchAgentInstallFixture {
  return { env, stdout: new PassThrough(), programArguments, ...overrides };
}

export function defaultLaunchAgentFixture(
  env: LaunchAgentInstallFixture["env"],
  overrides: LaunchAgentInstallOverrides = {},
): LaunchAgentInstallFixture {
  return launchAgentFixture(env, defaultProgramArguments, overrides);
}

type LaunchAgentControlFixture = Parameters<typeof stopLaunchAgent>[0] &
  Parameters<typeof uninstallLaunchAgent>[0];

export function launchAgentControlFixture(
  env: LaunchAgentControlFixture["env"],
  overrides: Omit<LaunchAgentControlFixture, "env" | "stdout"> = {},
): LaunchAgentControlFixture {
  return { env, stdout: new PassThrough(), ...overrides };
}

export function capturePassThroughOutput(
  append: (text: string) => void,
  encoding?: BufferEncoding,
): PassThrough {
  const stdout = new PassThrough();
  stdout.on("data", (chunk: Buffer) => append(chunk.toString(encoding)));
  return stdout;
}
