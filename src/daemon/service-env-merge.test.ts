import path from "node:path";
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  mergeGatewayServiceEnv,
  resolveWindowsServiceCommandProfile,
} from "./service-env-merge.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

describe("Windows service command profile", () => {
  const profileCases: Array<
    Pick<GatewayServiceCommandConfig, "programArguments" | "environment"> & {
      name: string;
      profile: string;
      source: "argv" | "environment" | "default";
    }
  > = [
    {
      name: "Node runtime options before the entrypoint",
      programArguments: [
        "node.exe",
        "--import",
        "bootstrap.mjs",
        "openclaw.mjs",
        "--profile=ops",
        "gateway",
      ],
      environment: { OPENCLAW_PROFILE: "saved" },
      profile: "ops",
      source: "argv",
    },
    {
      name: "direct executable with root dev",
      programArguments: ["openclaw.exe", "--dev", "gateway"],
      environment: { OPENCLAW_PROFILE: "saved" },
      profile: "dev",
      source: "argv",
    },
    {
      name: "gateway-local dev does not select a profile",
      programArguments: ["openclaw.exe", "gateway", "--dev"],
      environment: { openclaw_profile: "saved" },
      profile: "saved",
      source: "environment",
    },
    {
      name: "terminator leaves following profile text as command arguments",
      programArguments: ["node.exe", "openclaw.mjs", "gateway", "--", "--profile", "other"],
      environment: { OPENCLAW_PROFILE: "saved" },
      profile: "saved",
      source: "environment",
    },
    {
      name: "implicit default",
      programArguments: ["openclaw.exe", "gateway"],
      environment: undefined,
      profile: "default",
      source: "default",
    },
    {
      name: "blank saved profile is absent",
      programArguments: ["openclaw.exe", "gateway"],
      environment: { OPENCLAW_PROFILE: " \t " },
      profile: "default",
      source: "default",
    },
    {
      name: "saved default normalization",
      programArguments: ["openclaw.exe", "gateway"],
      environment: { OPENCLAW_PROFILE: "Default" },
      profile: "default",
      source: "environment",
    },
  ];
  it.each(profileCases)(
    "resolves $name without rewriting captured command evidence",
    ({ programArguments, environment, profile, source }) => {
      const command: GatewayServiceCommandConfig = { programArguments, environment };
      const captured = structuredClone(command);

      expect(resolveWindowsServiceCommandProfile(command)).toEqual({
        kind: "resolved",
        profile,
        source,
      });
      expect(command).toEqual(captured);
    },
  );

  it.each([
    { programArguments: [], environment: undefined },
    { programArguments: ["node.exe", ""], environment: undefined },
    {
      programArguments: ["node.exe", "--unknown-runtime-flag", "openclaw.mjs", "gateway"],
      environment: undefined,
    },
    { programArguments: ["node.exe", "--eval", "code"], environment: undefined },
    {
      programArguments: ["openclaw.exe", "--profile", "bad profile", "gateway"],
      environment: undefined,
    },
    {
      programArguments: ["openclaw.exe", "--profile=rescue", "gateway"],
      environment: { OPENCLAW_PROFILE: "bad profile" },
    },
  ])("does not invent a default profile for unavailable command facts: %j", (command) => {
    expect(resolveWindowsServiceCommandProfile(command)).toEqual({ kind: "unavailable" });
  });
});

describe("mergeGatewayServiceEnv", () => {
  it.each([
    { platform: "win32", lowercase: false },
    { platform: "win32", lowercase: true },
    { platform: "linux", lowercase: false },
  ] as const)(
    "projects argv profile on $platform with lowercase=$lowercase without redirecting native service identity",
    ({ platform, lowercase }) => {
      withMockedPlatform(platform, () => {
        const home = path.resolve("service-profile-fixture");
        const caller = {
          HOME: home,
          OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected",
          OPENCLAW_LAUNCHD_LABEL: "caller-agent",
          OPENCLAW_SYSTEMD_UNIT: "caller-unit.service",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/caller-bus",
          USER: "caller",
        };
        const command: GatewayServiceCommandConfig = {
          programArguments: [
            "node.exe",
            "--import",
            "bootstrap.mjs",
            "openclaw.mjs",
            "--profile",
            "rescue",
            "gateway",
          ],
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
        const baseEnv = lowercase
          ? Object.fromEntries(
              Object.entries(caller).map(([key, value]) => [key.toLowerCase(), value]),
            )
          : caller;
        if (lowercase) {
          command.environment = Object.fromEntries(
            Object.entries(command.environment!).map(([key, value]) => [key.toLowerCase(), value]),
          );
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
          OPENCLAW_LAUNCHD_LABEL: "caller-agent",
          OPENCLAW_SYSTEMD_UNIT: "caller-unit.service",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/caller-bus",
          USER: "caller",
        });
        expect(merged.OPENCLAW_CONFIG_PATH).toBe(
          platform === "win32" ? undefined : command.environment?.OPENCLAW_CONFIG_PATH,
        );
        expect({ baseEnv, command }).toEqual(captured);
      });
    },
  );

  it("projects a direct executable argv profile when no launcher environment exists", () => {
    withMockedPlatform("win32", () => {
      const home = path.resolve("direct-service-profile-fixture");
      const baseEnv = { HOME: home, OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected" };
      const merged = mergeGatewayServiceEnv(baseEnv, {
        programArguments: ["openclaw.exe", "--profile=rescue", "gateway"],
      });
      expect(merged).toMatchObject({
        OPENCLAW_PROFILE: "rescue",
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw-rescue"),
        OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-rescue", "openclaw.json"),
        OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected",
      });
      expect(baseEnv).toEqual({ HOME: home, OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected" });
    });
  });
});
