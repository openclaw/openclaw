import { Command } from "commander";
import { describe, expect, it } from "vitest";

describe("browser CLI --browser-profile flag", () => {
  it("parses --browser-profile from parent command options", () => {
    const program = new Command();
    program.name("test");

    const browser = program
      .command("browser")
      .option("--browser-profile <name>", "Browser profile name");

    let capturedProfile: string | undefined;

    browser.command("status").action((_opts, cmd) => {
      const parent = cmd.parent?.opts?.() as { browserProfile?: string };
      capturedProfile = parent?.browserProfile;
    });

    program.parse([
      "node",
      "test",
      "browser",
      "--browser-profile",
      "onasset",
      "status",
    ]);

    expect(capturedProfile).toBe("onasset");
  });

  it("defaults to undefined when --browser-profile not provided", () => {
    const program = new Command();
    program.name("test");

    const browser = program
      .command("browser")
      .option("--browser-profile <name>", "Browser profile name");

    let capturedProfile: string | undefined = "should-be-undefined";

    browser.command("status").action((_opts, cmd) => {
      const parent = cmd.parent?.opts?.() as { browserProfile?: string };
      capturedProfile = parent?.browserProfile;
    });

    program.parse(["node", "test", "browser", "status"]);

    expect(capturedProfile).toBeUndefined();
  });

  it("does not conflict with global --profile flag", () => {
    // The global --profile flag is handled by entry.js before Commander
    // This test verifies --browser-profile is a separate option
    const program = new Command();
    program.name("test");
    program.option("--profile <name>", "Global config profile");

    const browser = program
      .command("browser")
      .option("--browser-profile <name>", "Browser profile name");

    let globalProfile: string | undefined;
    let browserProfile: string | undefined;

    browser.command("status").action((_opts, cmd) => {
      const parent = cmd.parent?.opts?.() as { browserProfile?: string };
      browserProfile = parent?.browserProfile;
      globalProfile = program.opts().profile;
    });

    program.parse([
      "node",
      "test",
      "--profile",
      "dev",
      "browser",
      "--browser-profile",
      "onasset",
      "status",
    ]);

    expect(globalProfile).toBe("dev");
    expect(browserProfile).toBe("onasset");
  });
});
