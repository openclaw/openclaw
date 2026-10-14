import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it.each([
    {
      args: ["--no-color", "gateway", "--dev", "--allow-unconfigured"],
      profile: null,
      remaining: ["--no-color", "gateway", "--dev", "--allow-unconfigured"],
    },
    {
      args: ["qa", "matrix", "--profile", "fast", "--fail-fast"],
      profile: null,
      remaining: ["qa", "matrix", "--profile", "fast", "--fail-fast"],
    },
    {
      args: ["qa", "run", "--profile=release", "--output", "qa-report.md"],
      profile: "release",
      remaining: ["qa", "run", "--output", "qa-report.md"],
    },
  ])(
    "selects the root profile without consuming command-local flags: $args",
    ({ args, profile, remaining }) => {
      expect(parseCliProfileArgs(["node", "openclaw", ...args])).toEqual({
        ok: true,
        profile,
        argv: ["node", "openclaw", ...remaining],
      });
    },
  );

  it("rejects missing profile value", () => {
    expect(parseCliProfileArgs(["node", "openclaw", "--profile"]).ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "openclaw", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "openclaw", "--profile", "work", "--dev", "status"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    expect(parseCliProfileArgs(argv).ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_PROFILE: "prod",
      OPENCLAW_STATE_DIR: "/custom",
      OPENCLAW_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.OPENCLAW_PROFILE).toBe("dev");
    expect(env.OPENCLAW_STATE_DIR).toBe("/custom");
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19099");
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join("/custom", "openclaw.json"));
  });

  it.each([{ name: "named service to dev", inheritedProfile: "main", selected: "dev" }])(
    "replaces the complete service selector bundle: $name",
    ({ inheritedProfile, selected }) => {
      const inheritedStateDir = inheritedProfile
        ? `/home/peter/.openclaw-${inheritedProfile}`
        : "/home/peter/.openclaw";
      const env: Record<string, string | undefined> = {
        OPENCLAW_PROFILE: inheritedProfile,
        OPENCLAW_STATE_DIR: inheritedStateDir,
        OPENCLAW_CONFIG_PATH: path.join(inheritedStateDir, "openclaw.json"),
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_LAUNCHD_LABEL: inheritedProfile
          ? `ai.openclaw.${inheritedProfile}`
          : "ai.openclaw.gateway",
        OPENCLAW_SYSTEMD_UNIT: inheritedProfile
          ? `openclaw-gateway-${inheritedProfile}.service`
          : "openclaw-gateway.service",
        OPENCLAW_WINDOWS_TASK_NAME: inheritedProfile
          ? `OpenClaw Gateway (${inheritedProfile})`
          : "OpenClaw Gateway",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      };

      applyCliProfileEnv({ profile: selected, env, homedir: () => "/home/peter" });

      expect(env.OPENCLAW_PROFILE).toBe(selected);
      expect(env.OPENCLAW_STATE_DIR).toBe(`/home/peter/.openclaw-${selected}`);
      expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined();
      expect(env.OPENCLAW_GATEWAY_PORT).toBe(selected === "dev" ? "19001" : undefined);
      expect(env.OPENCLAW_LAUNCHD_LABEL).toBeUndefined();
      expect(env.OPENCLAW_SYSTEMD_UNIT).toBeUndefined();
      expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBeUndefined();
    },
  );

  it("preserves node service selectors when selecting a CLI profile", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_PROFILE: "main",
      OPENCLAW_STATE_DIR: "/home/peter/.openclaw-main",
      OPENCLAW_CONFIG_PATH: "/home/peter/.openclaw-main/openclaw.json",
      OPENCLAW_GATEWAY_PORT: "19999",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-node.service",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "node",
    };

    applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19999");
    expect(env.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.node");
    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-node.service");
    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Node");
  });

  it.each([
    {
      name: "the default profile without a profile marker",
      inheritedProfile: undefined,
      inheritedStateDir: "/home/peter/.openclaw",
    },
  ])(
    "switches inherited canonical state from $name to the requested profile",
    ({ inheritedProfile, inheritedStateDir }) => {
      const env: Record<string, string | undefined> = {
        OPENCLAW_PROFILE: inheritedProfile,
        OPENCLAW_STATE_DIR: inheritedStateDir,
        OPENCLAW_CONFIG_PATH: path.join(inheritedStateDir, "openclaw.json"),
      };

      applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

      const expectedStateDir = path.join(path.resolve("/home/peter"), ".openclaw-work");
      expect(env.OPENCLAW_PROFILE).toBe("work");
      expect(env.OPENCLAW_STATE_DIR).toBe(expectedStateDir);
      expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(expectedStateDir, "openclaw.json"));
    },
  );

  it.each(["openclaw-gateway-main"])(
    "drops inherited canonical service identities when switching profiles (%s)",
    (systemdUnit) => {
      const env: Record<string, string | undefined> = {
        OPENCLAW_PROFILE: "main",
        OPENCLAW_STATE_DIR: "/home/peter/.openclaw-main",
        OPENCLAW_CONFIG_PATH: "/home/peter/.openclaw-main/openclaw.json",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.main",
        OPENCLAW_SYSTEMD_UNIT: systemdUnit,
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (main)",
      };

      applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

      expect(env.OPENCLAW_LAUNCHD_LABEL).toBeUndefined();
      expect(env.OPENCLAW_SYSTEMD_UNIT).toBeUndefined();
      expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBeUndefined();
    },
  );

  it.each([{ inheritedProfile: "Main", selectedProfile: "main" }])(
    "keeps case-distinct named profiles isolated ($inheritedProfile to $selectedProfile)",
    ({ inheritedProfile, selectedProfile }) => {
      const inheritedStateDir = `/home/peter/.openclaw-${inheritedProfile}`;
      const env: Record<string, string | undefined> = {
        OPENCLAW_PROFILE: inheritedProfile,
        OPENCLAW_STATE_DIR: inheritedStateDir,
        OPENCLAW_CONFIG_PATH: path.join(inheritedStateDir, "openclaw.json"),
      };

      applyCliProfileEnv({ profile: selectedProfile, env, homedir: () => "/home/peter" });

      const expectedStateDir = `/home/peter/.openclaw-${selectedProfile}`;
      expect(env.OPENCLAW_PROFILE).toBe(selectedProfile);
      expect(env.OPENCLAW_STATE_DIR).toBe(expectedStateDir);
      expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(expectedStateDir, "openclaw.json"));
    },
  );
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "profile is Default (case-insensitive)",
      cmd: "openclaw doctor --fix",
      env: { OPENCLAW_PROFILE: "Default" },
      expected: "openclaw doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "openclaw doctor --fix",
      env: { OPENCLAW_PROFILE: "bad profile" },
      expected: "openclaw doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "openclaw --dev doctor",
      env: { OPENCLAW_PROFILE: "dev" },
      expected: "openclaw --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "  jbopenclaw  " })).toBe(
      "openclaw --profile jbopenclaw doctor --fix",
    );
  });

  it("ignores unsafe container hints", () => {
    expect(
      formatCliCommand("openclaw gateway status --deep", {
        OPENCLAW_CONTAINER_HINT: "demo; rm -rf /",
      }),
    ).toBe("openclaw gateway status --deep");
  });

  it.each([["pnpm openclaw", "plugins update telegram"]])(
    "preserves the active container for non-root update: %s %s",
    (prefix, command) => {
      expect(
        formatCliCommand(`${prefix} ${command}`, {
          OPENCLAW_CONTAINER_HINT: "demo",
          OPENCLAW_PROFILE: "work",
        }),
      ).toBe(`${prefix} --container demo ${command}`);
    },
  );
});
