import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "EasyHub",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "EasyHub", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "EasyHub", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "EasyHub", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "EasyHub", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "EasyHub", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "EasyHub", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "EasyHub", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "EasyHub", "--profile", "work", "--dev", "status"]);
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
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".easyhub-dev");
    expect(env.EASYHUB_PROFILE).toBe("dev");
    expect(env.EASYHUB_STATE_DIR).toBe(expectedStateDir);
    expect(env.EASYHUB_CONFIG_PATH).toBe(path.join(expectedStateDir, "easyhub.json"));
    expect(env.EASYHUB_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      EASYHUB_STATE_DIR: "/custom",
      EASYHUB_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.EASYHUB_STATE_DIR).toBe("/custom");
    expect(env.EASYHUB_GATEWAY_PORT).toBe("19099");
    expect(env.EASYHUB_CONFIG_PATH).toBe(path.join("/custom", "easyhub.json"));
  });

  it("uses EASYHUB_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      EASYHUB_HOME: "/srv/EasyHub-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/EasyHub-home");
    expect(env.EASYHUB_STATE_DIR).toBe(path.join(resolvedHome, ".EasyHub-work"));
    expect(env.EASYHUB_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".EasyHub-work", "easyhub.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("EasyHub doctor --fix", {})).toBe("EasyHub doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("EasyHub doctor --fix", { EASYHUB_PROFILE: "default" })).toBe(
      "EasyHub doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("EasyHub doctor --fix", { EASYHUB_PROFILE: "Default" })).toBe(
      "EasyHub doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("EasyHub doctor --fix", { EASYHUB_PROFILE: "bad profile" })).toBe(
      "EasyHub doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("EasyHub --profile work doctor --fix", { EASYHUB_PROFILE: "work" }),
    ).toBe("EasyHub --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("EasyHub --dev doctor", { EASYHUB_PROFILE: "dev" })).toBe(
      "EasyHub --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("EasyHub doctor --fix", { EASYHUB_PROFILE: "work" })).toBe(
      "EasyHub --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("EasyHub doctor --fix", { EASYHUB_PROFILE: "  jbEasyHub  " })).toBe(
      "EasyHub --profile jbEasyHub doctor --fix",
    );
  });

  it("handles command with no args after EasyHub", () => {
    expect(formatCliCommand("EasyHub", { EASYHUB_PROFILE: "test" })).toBe(
      "EasyHub --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm EasyHub doctor", { EASYHUB_PROFILE: "work" })).toBe(
      "pnpm EasyHub --profile work doctor",
    );
  });
});
