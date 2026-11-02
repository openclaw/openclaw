import path from "node:path";
import { expect, it } from "vitest";
import { resolveStateDir } from "../config/state-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  mergeGatewayServiceEnv,
  resolveWindowsServiceCommandProfile,
} from "./service-env-merge.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

const saved = { OPENCLAW_PROFILE: "saved" };
it.each(["darwin", "linux", "win32"] as const)(
  "keeps caller state selectors out of installed payloads on %s",
  (platform) =>
    withMockedPlatform(platform, () => {
      const home = path.resolve("service-home");
      const caller = {
        HOME: home,
        OPENCLAW_HOME: path.join(home, "caller-home"),
        OPENCLAW_STATE_DIR: path.join(home, "caller-state"),
        OPENCLAW_PROFILE: "caller",
        OPENCLAW_CONFIG_PATH: path.join(home, "caller.json"),
      };
      for (const environment of [undefined, {}]) {
        const merged = mergeGatewayServiceEnv(caller, {
          programArguments: ["node", "openclaw.mjs", "gateway"],
          environment,
        });
        expect(resolveStateDir(merged)).toBe(path.join(home, ".openclaw"));
        expect(merged.OPENCLAW_CONFIG_PATH).toBeUndefined();
      }
    }),
);
const executable = "openclaw.exe|gateway";
const node = "node.exe|--import|bootstrap.mjs|openclaw.mjs";
const configPath = (dir: string) => path.join(dir, "openclaw.json");
type Environment = GatewayServiceCommandConfig["environment"];
const profileCases: Array<[string, Environment?, string?, ("argv" | "environment" | "default")?]> =
  [
    [`${node}|--profile=ops|gateway`, saved, "ops", "argv"],
    ["openclaw.exe|--dev|gateway", saved, "dev", "argv"],
    ["openclaw.exe|gateway|--dev", { openclaw_profile: "saved" }, "saved", "environment"],
    [executable, undefined, "default", "default"],
    [executable, { OPENCLAW_PROFILE: "Default" }, "default", "environment"],
    [""],
    ["node.exe|"],
    ["node.exe|--unknown-runtime-flag|openclaw.mjs|gateway"],
    ["openclaw.exe|--profile|bad profile|gateway"],
    ["openclaw.exe|--profile=rescue|gateway", { OPENCLAW_PROFILE: "bad profile" }],
  ];
it.each(profileCases)(
  "resolves Windows service profile: %s without rewriting command evidence",
  (argv, environment, profile, source) => {
    const command = { programArguments: argv ? argv.split("|") : [], environment };
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
      const savedDir = path.join(home, ".openclaw-saved");
      const rescueDir = path.join(home, ".openclaw-rescue");
      const serviceIdentity = {
        OPENCLAW_LAUNCHD_LABEL: "caller-agent",
        OPENCLAW_SYSTEMD_UNIT: "caller-unit.service",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/caller-bus",
        USER: "caller",
      };
      const identity = direct ? {} : serviceIdentity;
      const caller = {
        HOME: home,
        OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected",
        ...identity,
      };
      const command: GatewayServiceCommandConfig = direct
        ? { programArguments: ["openclaw.exe", "--profile=rescue", "gateway"] }
        : {
            programArguments: `${node}|--profile|rescue|gateway`.split("|"),
            environment: {
              OPENCLAW_PROFILE: "saved",
              OPENCLAW_STATE_DIR: savedDir,
              OPENCLAW_CONFIG_PATH: configPath(savedDir),
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

      const windows = platform === "win32";
      const expectedConfig = direct
        ? configPath(rescueDir)
        : windows
          ? undefined
          : configPath(savedDir);
      expect(merged.OPENCLAW_CONFIG_PATH).toBe(expectedConfig);
      expect(merged).toMatchObject({
        OPENCLAW_PROFILE: windows ? "rescue" : "saved",
        OPENCLAW_STATE_DIR: windows ? rescueDir : savedDir,
        OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected",
        ...identity,
      });
      expect({ baseEnv, command }).toEqual(captured);
    });
  },
);
