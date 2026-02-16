import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "smart-agent-neo",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "smart-agent-neo", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "smart-agent-neo", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "smart-agent-neo", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "smart-agent-neo", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "smart-agent-neo", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "smart-agent-neo", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "smart-agent-neo", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "smart-agent-neo", "--profile", "work", "--dev", "status"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".smart-agent-neo-dev");
    expect(env.SMART_AGENT_NEO_PROFILE).toBe("dev");
    expect(env.SMART_AGENT_NEO_STATE_DIR).toBe(expectedStateDir);
    expect(env.SMART_AGENT_NEO_CONFIG_PATH).toBe(path.join(expectedStateDir, "smart-agent-neo.json"));
    expect(env.SMART_AGENT_NEO_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      SMART_AGENT_NEO_STATE_DIR: "/custom",
      SMART_AGENT_NEO_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.SMART_AGENT_NEO_STATE_DIR).toBe("/custom");
    expect(env.SMART_AGENT_NEO_GATEWAY_PORT).toBe("19099");
    expect(env.SMART_AGENT_NEO_CONFIG_PATH).toBe(path.join("/custom", "smart-agent-neo.json"));
  });

  it("uses SMART_AGENT_NEO_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      SMART_AGENT_NEO_HOME: "/srv/smart-agent-neo-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/smart-agent-neo-home");
    expect(env.SMART_AGENT_NEO_STATE_DIR).toBe(path.join(resolvedHome, ".smart-agent-neo-work"));
    expect(env.SMART_AGENT_NEO_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".smart-agent-neo-work", "smart-agent-neo.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("smart-agent-neo doctor --fix", {})).toBe("smart-agent-neo doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("smart-agent-neo doctor --fix", { SMART_AGENT_NEO_PROFILE: "default" })).toBe(
      "smart-agent-neo doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("smart-agent-neo doctor --fix", { SMART_AGENT_NEO_PROFILE: "Default" })).toBe(
      "smart-agent-neo doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("smart-agent-neo doctor --fix", { SMART_AGENT_NEO_PROFILE: "bad profile" })).toBe(
      "smart-agent-neo doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("smart-agent-neo --profile work doctor --fix", { SMART_AGENT_NEO_PROFILE: "work" }),
    ).toBe("smart-agent-neo --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("smart-agent-neo --dev doctor", { SMART_AGENT_NEO_PROFILE: "dev" })).toBe(
      "smart-agent-neo --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("smart-agent-neo doctor --fix", { SMART_AGENT_NEO_PROFILE: "work" })).toBe(
      "smart-agent-neo --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("smart-agent-neo doctor --fix", { SMART_AGENT_NEO_PROFILE: "  jbsmart-agent-neo  " })).toBe(
      "smart-agent-neo --profile jbsmart-agent-neo doctor --fix",
    );
  });

  it("handles command with no args after smart-agent-neo", () => {
    expect(formatCliCommand("smart-agent-neo", { SMART_AGENT_NEO_PROFILE: "test" })).toBe(
      "smart-agent-neo --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm smart-agent-neo doctor", { SMART_AGENT_NEO_PROFILE: "work" })).toBe(
      "pnpm smart-agent-neo --profile work doctor",
    );
  });
});
