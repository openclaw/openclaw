import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertGatewayServiceMutationAllowed,
  formatExternalSupervisorUpdateRequired,
  isGatewayExternallySupervised,
  NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON,
} from "./gateway-supervision.js";

const profileEnv = () => {
  const HOME = os.userInfo().homedir;
  const OPENCLAW_STATE_DIR = path.join(HOME, ".openclaw-work");
  return {
    HOME,
    OPENCLAW_PROFILE: "work",
    OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: path.join(OPENCLAW_STATE_DIR, "openclaw.json"),
  };
};
const mutate = (env: NodeJS.ProcessEnv) => () =>
  assertGatewayServiceMutationAllowed("restart the gateway", env);
afterEach(() => vi.restoreAllMocks());

describe("gateway supervision", () => {
  it("defaults to automatic supervision", () => {
    expect(isGatewayExternallySupervised({})).toBe(false);
  });

  it("blocks native service mutation with actionable guidance", () => {
    expect(mutate({ OPENCLAW_SUPERVISOR_MODE: "external" })).toThrow(
      "OpenClaw gateway lifecycle is managed by an external supervisor " +
        "(OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to restart the gateway.",
    );
  });

  it("blocks native service mutation for non-default install identity", () => {
    expect(
      mutate({ HOME: "/home/operator", OPENCLAW_CONFIG_PATH: "/tmp/copied-openclaw.json" }),
    ).toThrow(
      `${NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON}. Rerun with HOME set to the OS account home, OPENCLAW_HOME either unset or pointing at that same home, and OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH either unset or pointing at the canonical paths for that account home and profile to restart the gateway.`,
    );
  });

  it("allows native service mutation for a named profile's canonical state dir", () => {
    expect(mutate(profileEnv())).not.toThrow();
  });

  it.each([
    ["darwin", "macOS", "OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.gateway"],
    ["linux", "Linux", "OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service"],
    ["win32", "Windows", "OPENCLAW_WINDOWS_TASK_NAME", "OpenClaw Gateway"],
  ] as const)(
    "rejects named-profile service overrides on %s",
    (platform, platformName, envKey, value) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      expect(mutate({ ...profileEnv(), [envKey]: value })).toThrow(
        `named profiles cannot override ${envKey} for ${platformName} service management`,
      );
    },
  );

  it("rejects macOS profile names that collide with reserved LaunchAgent identities", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(mutate({ OPENCLAW_PROFILE: "gateway" })).toThrow(
      'macOS profile "gateway" conflicts with a reserved LaunchAgent identity',
    );
  });

  it.each([
    { platform: "darwin" as const, platformName: "macOS" },
    { platform: "win32" as const, platformName: "Windows" },
  ])(
    "rejects case-distinct native service identities on $platformName",
    ({ platform, platformName }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      expect(mutate({ OPENCLAW_PROFILE: "Main" })).toThrow(
        `${platformName} profile "Main" is not lowercase-safe for case-insensitive state and native-service paths`,
      );
    },
  );

  it("explains why self-update must be delegated", () => {
    expect(formatExternalSupervisorUpdateRequired()).toContain(
      "stop the gateway, update and finalize the runtime, then restart it safely",
    );
  });
});
