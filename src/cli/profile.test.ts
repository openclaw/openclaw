import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "dna",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "dna", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "dna", "--dev", "gateway"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "dna", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "dna", "--profile", "work", "status"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "dna", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "dna", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "dna", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "dna", "--profile", "work", "--dev", "status"]);
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
    const expectedStateDir = path.join("/home/peter", ".dna-dev");
    expect(env.DNA_PROFILE).toBe("dev");
    expect(env.DNA_STATE_DIR).toBe(expectedStateDir);
    expect(env.DNA_CONFIG_PATH).toBe(path.join(expectedStateDir, "dna.json"));
    expect(env.DNA_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      DNA_STATE_DIR: "/custom",
      DNA_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.DNA_STATE_DIR).toBe("/custom");
    expect(env.DNA_GATEWAY_PORT).toBe("19099");
    expect(env.DNA_CONFIG_PATH).toBe(path.join("/custom", "dna.json"));
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("dna doctor --fix", {})).toBe("dna doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("dna doctor --fix", { DNA_PROFILE: "default" })).toBe(
      "dna doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("dna doctor --fix", { DNA_PROFILE: "Default" })).toBe(
      "dna doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("dna doctor --fix", { DNA_PROFILE: "bad profile" })).toBe(
      "dna doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("dna --profile work doctor --fix", { DNA_PROFILE: "work" }),
    ).toBe("dna --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("dna --dev doctor", { DNA_PROFILE: "dev" })).toBe(
      "dna --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("dna doctor --fix", { DNA_PROFILE: "work" })).toBe(
      "dna --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("dna doctor --fix", { DNA_PROFILE: "  jbclawd  " })).toBe(
      "dna --profile jbclawd doctor --fix",
    );
  });

  it("handles command with no args after dna", () => {
    expect(formatCliCommand("dna", { DNA_PROFILE: "test" })).toBe(
      "dna --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm dna doctor", { DNA_PROFILE: "work" })).toBe(
      "pnpm dna --profile work doctor",
    );
  });
});
