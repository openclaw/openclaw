import path from "node:path";
import { expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  mergeGatewayServiceEnv,
  resolveWindowsServiceCommandProfile,
} from "./service-env-merge.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

const saved = { OPENCLAW_PROFILE: "saved" };
const executable = "openclaw.exe|gateway";
const profileCases: Array<
  [
    name: string,
    argv: string,
    environment?: GatewayServiceCommandConfig["environment"],
    profile?: string,
    source?: "argv" | "environment" | "default",
  ]
> = [
  [
    "Node runtime options",
    "node.exe|--import|bootstrap.mjs|openclaw.mjs|--profile=ops|gateway",
    saved,
    "ops",
    "argv",
  ],
  ["root dev", "openclaw.exe|--dev|gateway", saved, "dev", "argv"],
  [
    "gateway-local dev",
    "openclaw.exe|gateway|--dev",
    { openclaw_profile: "saved" },
    "saved",
    "environment",
  ],
  [
    "profile after terminator",
    "node.exe|openclaw.mjs|gateway|--|--profile|other",
    saved,
    "saved",
    "environment",
  ],
  ["implicit default", executable, undefined, "default", "default"],
  ["blank saved profile", executable, { OPENCLAW_PROFILE: " \t " }, "default", "default"],
  ["saved default", executable, { OPENCLAW_PROFILE: "Default" }, "default", "environment"],
  ["missing executable", ""],
  ["missing entrypoint", "node.exe|"],
  ["unknown runtime flag", "node.exe|--unknown-runtime-flag|openclaw.mjs|gateway"],
  ["eval runtime", "node.exe|--eval|code"],
  ["invalid argv profile", "openclaw.exe|--profile|bad profile|gateway"],
  [
    "invalid saved profile",
    "openclaw.exe|--profile=rescue|gateway",
    { OPENCLAW_PROFILE: "bad profile" },
  ],
];
it.each(profileCases)(
  "resolves Windows service profile: %s without rewriting command evidence",
  (_name, argv, environment, profile, source) => {
    const command: GatewayServiceCommandConfig = {
      programArguments: argv ? argv.split("|") : [],
      environment,
    };
    const captured = structuredClone(command);

    expect(resolveWindowsServiceCommandProfile(command)).toEqual(
      profile === undefined ? { kind: "unavailable" } : { kind: "resolved", profile, source },
    );
    expect(command).toEqual(captured);
  },
);
it.each([
  { platform: "win32", lowercase: false, direct: false },
  { platform: "win32", lowercase: false, direct: true },
  { platform: "win32", lowercase: true, direct: false },
  { platform: "linux", lowercase: false, direct: false },
] as const)(
  "projects argv profile on $platform with lowercase=$lowercase direct=$direct without redirecting native service identity",
  ({ platform, lowercase, direct }) => {
    withMockedPlatform(platform, () => {
      const home = path.resolve("service-profile-fixture");
      const identity: Record<string, string> = direct
        ? {}
        : {
            OPENCLAW_LAUNCHD_LABEL: "caller-agent",
            OPENCLAW_SYSTEMD_UNIT: "caller-unit.service",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/caller-bus",
            USER: "caller",
          };
      const caller = {
        HOME: home,
        OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected",
        ...identity,
      };
      const command: GatewayServiceCommandConfig = direct
        ? { programArguments: ["openclaw.exe", "--profile=rescue", "gateway"] }
        : {
            programArguments:
              "node.exe|--import|bootstrap.mjs|openclaw.mjs|--profile|rescue|gateway".split("|"),
            environment: {
              OPENCLAW_PROFILE: "saved",
              OPENCLAW_STATE_DIR: path.join(home, ".openclaw-saved"),
              OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-saved", "openclaw.json"),
              OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (saved)",
              OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.saved",
              OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-saved.service",
              OPENCLAW_SERVICE_MARKER: "openclaw",
              OPENCLAW_SERVICE_KIND: "gateway",
              DBUS_SESSION_BUS_ADDRESS: "unix:path=/payload-bus",
              USER: "payload",
            },
          };
      const lower = (env: NonNullable<GatewayServiceCommandConfig["environment"]>) =>
        Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
      const baseEnv = lowercase ? lower(caller) : caller;
      if (lowercase) {
        command.environment = lower(command.environment!);
      }
      const captured = structuredClone({ baseEnv, command });

      const merged = mergeGatewayServiceEnv(baseEnv, command);

      expect(merged).toMatchObject({
        OPENCLAW_PROFILE: platform === "win32" ? "rescue" : "saved",
        OPENCLAW_STATE_DIR: path.join(
          home,
          platform === "win32" ? ".openclaw-rescue" : ".openclaw-saved",
        ),
        OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected",
        ...identity,
      });
      expect(merged.OPENCLAW_CONFIG_PATH).toBe(
        direct
          ? path.join(home, ".openclaw-rescue", "openclaw.json")
          : platform === "win32"
            ? undefined
            : command.environment?.OPENCLAW_CONFIG_PATH,
      );
      expect({ baseEnv, command }).toEqual(captured);
    });
  },
);
