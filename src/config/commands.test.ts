import { describe, expect, it } from "vitest";
import {
  isCommandFlagEnabled,
  isRestartEnabled,
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "./commands.js";
import { CommandsSchema } from "./zod-schema.session.js";

describe("CommandsSchema defaults", () => {
  it("defaults nativeSkills to false", () => {
    const parsed = CommandsSchema.parse({});
    expect(parsed.nativeSkills).toBe(false);
  });

  it("defaults nativeSkills to false in the factory default", () => {
    const parsed = CommandsSchema.parse(undefined);
    expect(parsed.nativeSkills).toBe(false);
  });

  it("preserves explicit nativeSkills auto", () => {
    const parsed = CommandsSchema.parse({ nativeSkills: "auto" });
    expect(parsed.nativeSkills).toBe("auto");
  });

  it("preserves explicit nativeSkills true", () => {
    const parsed = CommandsSchema.parse({ nativeSkills: true });
    expect(parsed.nativeSkills).toBe(true);
  });
});

describe("resolveNativeSkillsEnabled", () => {
  it("returns false when schema default (false) is used as globalSetting", () => {
    expect(
      resolveNativeSkillsEnabled({
        providerId: "discord",
        globalSetting: false,
      }),
    ).toBe(false);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "telegram",
        globalSetting: false,
      }),
    ).toBe(false);
  });

  it("uses provider defaults for auto", () => {
    expect(
      resolveNativeSkillsEnabled({
        providerId: "discord",
        globalSetting: "auto",
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "telegram",
        globalSetting: "auto",
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "slack",
        globalSetting: "auto",
      }),
    ).toBe(false);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "whatsapp",
        globalSetting: "auto",
      }),
    ).toBe(false);
  });

  it("honors explicit provider settings", () => {
    expect(
      resolveNativeSkillsEnabled({
        providerId: "slack",
        providerSetting: true,
        globalSetting: "auto",
      }),
    ).toBe(true);
    expect(
      resolveNativeSkillsEnabled({
        providerId: "discord",
        providerSetting: false,
        globalSetting: true,
      }),
    ).toBe(false);
  });
});

describe("resolveNativeCommandsEnabled", () => {
  it("follows the same provider default heuristic", () => {
    expect(resolveNativeCommandsEnabled({ providerId: "discord", globalSetting: "auto" })).toBe(
      true,
    );
    expect(resolveNativeCommandsEnabled({ providerId: "telegram", globalSetting: "auto" })).toBe(
      true,
    );
    expect(resolveNativeCommandsEnabled({ providerId: "slack", globalSetting: "auto" })).toBe(
      false,
    );
  });

  it("honors explicit provider/global booleans", () => {
    expect(
      resolveNativeCommandsEnabled({
        providerId: "slack",
        providerSetting: true,
        globalSetting: false,
      }),
    ).toBe(true);
    expect(
      resolveNativeCommandsEnabled({
        providerId: "discord",
        globalSetting: false,
      }),
    ).toBe(false);
  });
});

describe("isNativeCommandsExplicitlyDisabled", () => {
  it("returns true only for explicit false at provider or fallback global", () => {
    expect(
      isNativeCommandsExplicitlyDisabled({ providerSetting: false, globalSetting: true }),
    ).toBe(true);
    expect(
      isNativeCommandsExplicitlyDisabled({ providerSetting: undefined, globalSetting: false }),
    ).toBe(true);
    expect(
      isNativeCommandsExplicitlyDisabled({ providerSetting: true, globalSetting: false }),
    ).toBe(false);
    expect(
      isNativeCommandsExplicitlyDisabled({ providerSetting: "auto", globalSetting: false }),
    ).toBe(false);
  });
});

describe("isRestartEnabled", () => {
  it("defaults to enabled unless explicitly false", () => {
    expect(isRestartEnabled(undefined)).toBe(true);
    expect(isRestartEnabled({})).toBe(true);
    expect(isRestartEnabled({ commands: {} })).toBe(true);
    expect(isRestartEnabled({ commands: { restart: true } })).toBe(true);
    expect(isRestartEnabled({ commands: { restart: false } })).toBe(false);
  });

  it("ignores inherited restart flags", () => {
    expect(
      isRestartEnabled({
        commands: Object.create({ restart: false }) as Record<string, unknown>,
      }),
    ).toBe(true);
  });
});

describe("isCommandFlagEnabled", () => {
  it("requires own boolean true", () => {
    expect(isCommandFlagEnabled({ commands: { bash: true } }, "bash")).toBe(true);
    expect(isCommandFlagEnabled({ commands: { bash: false } }, "bash")).toBe(false);
    expect(
      isCommandFlagEnabled(
        {
          commands: Object.create({ bash: true }) as Record<string, unknown>,
        },
        "bash",
      ),
    ).toBe(false);
  });
});
