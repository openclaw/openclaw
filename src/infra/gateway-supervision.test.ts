import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertGatewayServiceMutationAllowed,
  formatExternalSupervisorUpdateRequired,
  isGatewayExternallySupervised,
  NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON,
  resolveExternalSupervisorGuidance,
} from "./gateway-supervision.js";

// The env variable name is part of the observable contract the messages
// reference; the mode resolver is internal and proven through the public
// isGatewayExternallySupervised surface.
const GATEWAY_SUPERVISOR_MODE_ENV = "OPENCLAW_SUPERVISOR_MODE";

describe("gateway supervision", () => {
  it.each([
    { value: undefined, expected: "auto" },
    { value: "", expected: "auto" },
    { value: "auto", expected: "auto" },
    { value: "invalid", expected: "auto" },
    { value: " EXTERNAL ", expected: "external" },
    { value: "docker", expected: "external" },
    { value: " CLAWCTL ", expected: "external" },
  ])("resolves $value as $expected", ({ value, expected }) => {
    const env = { [GATEWAY_SUPERVISOR_MODE_ENV]: value };

    expect(isGatewayExternallySupervised(env)).toBe(expected === "external");
  });

  it("blocks native service mutation with actionable guidance", () => {
    expect(() =>
      assertGatewayServiceMutationAllowed("restart the gateway", {
        [GATEWAY_SUPERVISOR_MODE_ENV]: "external",
      }),
    ).toThrow(
      "OpenClaw gateway lifecycle is managed by an external supervisor " +
        "(OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to restart the gateway.",
    );
  });

  it.each([
    { OPENCLAW_STATE_DIR: "/tmp/copied-state" },
    { OPENCLAW_CONFIG_PATH: "/tmp/copied-openclaw.json" },
  ])("blocks native service mutation for non-default install identity %#", (override) => {
    expect(() =>
      assertGatewayServiceMutationAllowed("restart the gateway", {
        HOME: "/home/operator",
        ...override,
      }),
    ).toThrow(
      `${NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON}. Rerun with HOME set to the OS account home, without OPENCLAW_HOME, and with OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH either unset or pointing at the canonical paths for that account home and profile to restart the gateway.`,
    );
  });

  it("allows native service mutation for a named profile's canonical state dir", () => {
    const accountHome = os.userInfo().homedir;

    expect(() =>
      assertGatewayServiceMutationAllowed("restart the gateway", {
        HOME: accountHome,
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: path.join(accountHome, ".openclaw-work"),
        OPENCLAW_CONFIG_PATH: path.join(accountHome, ".openclaw-work", "openclaw.json"),
      }),
    ).not.toThrow();
  });

  it.each([
    {
      platform: "darwin" as const,
      platformName: "macOS",
      envKey: "OPENCLAW_LAUNCHD_LABEL",
      value: "ai.openclaw.gateway",
    },
    {
      platform: "linux" as const,
      platformName: "Linux",
      envKey: "OPENCLAW_SYSTEMD_UNIT",
      value: "openclaw-gateway.service",
    },
    {
      platform: "win32" as const,
      platformName: "Windows",
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "OpenClaw Gateway",
    },
  ])(
    "rejects named-profile $envKey overrides on $platformName",
    ({ platform, platformName, envKey, value }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const accountHome = os.userInfo().homedir;
      try {
        expect(() =>
          assertGatewayServiceMutationAllowed("restart the gateway", {
            HOME: accountHome,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: path.join(accountHome, ".openclaw-work"),
            OPENCLAW_CONFIG_PATH: path.join(accountHome, ".openclaw-work", "openclaw.json"),
            [envKey]: value,
          }),
        ).toThrow(
          `named profiles cannot override ${envKey} for ${platformName} service management`,
        );
      } finally {
        platformSpy.mockRestore();
      }
    },
  );

  it("rejects macOS profile names that collide with reserved LaunchAgent identities", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      expect(() =>
        assertGatewayServiceMutationAllowed("restart the gateway", {
          OPENCLAW_PROFILE: "gateway",
        }),
      ).toThrow('macOS profile "gateway" conflicts with a reserved LaunchAgent identity');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it.each([
    { platform: "darwin" as const, platformName: "macOS" },
    { platform: "win32" as const, platformName: "Windows" },
  ])(
    "rejects case-distinct native service identities on $platformName",
    ({ platform, platformName }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      try {
        expect(() =>
          assertGatewayServiceMutationAllowed("restart the gateway", {
            OPENCLAW_PROFILE: "Main",
          }),
        ).toThrow(
          `${platformName} profile "Main" is not lowercase-safe for case-insensitive state and native-service paths`,
        );
      } finally {
        platformSpy.mockRestore();
      }
    },
  );

  it("explains why self-update must be delegated", () => {
    expect(formatExternalSupervisorUpdateRequired()).toContain(
      "stop the gateway, update and finalize the runtime, then restart it safely",
    );
  });

  it.each([
    {
      type: "docker",
      name: "Docker Compose",
      location:
        "Docker host, in this deployment's Compose project directory, using its existing Compose file set and order",
      command: "docker compose up -d openclaw-gateway",
    },
    {
      type: " CLAWCTL ",
      name: "clawctl",
      location: "Windows host session",
      command: "clawctl gateway-service start",
    },
  ])(
    "names $type and its start command in a native service refusal",
    ({ type, name, location, command }) => {
      expect(() =>
        assertGatewayServiceMutationAllowed(
          "start the gateway",
          {
            OPENCLAW_SUPERVISOR_MODE: type,
          },
          "start",
        ),
      ).toThrow(
        `OpenClaw gateway lifecycle is managed by ${name} (OPENCLAW_SUPERVISOR_MODE=${type.trim().toLowerCase()}).\nStart (${location}): ${command}`,
      );
    },
  );

  it.each([undefined, "", "auto", "unknown", "docker; echo unexpected"])(
    "keeps unrecognized mode %s outside external supervision",
    (mode) => {
      const env = {
        HOME: os.userInfo().homedir,
        OPENCLAW_SUPERVISOR_MODE: mode,
      };
      expect(resolveExternalSupervisorGuidance("start", env)).toBeUndefined();
      expect(() =>
        assertGatewayServiceMutationAllowed("start the gateway", env, "start"),
      ).not.toThrow();
    },
  );

  it("retains generic instructions for external mode", () => {
    const env = { OPENCLAW_SUPERVISOR_MODE: "external" };
    expect(resolveExternalSupervisorGuidance("start", env)).toBeUndefined();
    expect(() => assertGatewayServiceMutationAllowed("start the gateway", env, "start")).toThrow(
      "OpenClaw gateway lifecycle is managed by an external supervisor (OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to start the gateway.",
    );
  });

  it("uses the matching Docker repair action and keeps unsupported actions generic", () => {
    const env = { OPENCLAW_SUPERVISOR_MODE: "docker" };
    expect(() =>
      assertGatewayServiceMutationAllowed("repair the gateway service", env, "repair"),
    ).toThrow(
      "Repair (Docker host, in this deployment's Compose project directory, using its existing Compose file set and order): docker compose up -d --force-recreate openclaw-gateway",
    );
    expect(() =>
      assertGatewayServiceMutationAllowed("install the gateway service", env, "install"),
    ).toThrow("Use that supervisor to install the gateway service.");
  });

  it("shows the Docker update workflow without inventing a clawctl update command", () => {
    const env = { OPENCLAW_SUPERVISOR_MODE: "docker" };
    expect(
      formatExternalSupervisorUpdateRequired(resolveExternalSupervisorGuidance("update", env), env),
    ).toContain(
      "Update (Docker host, in this deployment's Compose project directory, using its existing Compose file set and order): docker compose pull openclaw-gateway && docker compose up -d openclaw-gateway",
    );
    const clawctlEnv = { OPENCLAW_SUPERVISOR_MODE: "clawctl" };
    const clawctlMessage = formatExternalSupervisorUpdateRequired(
      resolveExternalSupervisorGuidance("update", clawctlEnv),
      clawctlEnv,
    );
    expect(clawctlMessage).toContain("OPENCLAW_SUPERVISOR_MODE=clawctl");
    expect(clawctlMessage).toContain("Use the external supervisor's update workflow");
    expect(clawctlMessage).not.toContain("Update (Windows host session)");
  });
});
