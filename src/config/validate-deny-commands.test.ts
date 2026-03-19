import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import {
  collectAllKnownNodeCommands,
  looksLikeCommandPattern,
  validateDenyCommandEntries,
} from "./validate-deny-commands.js";

describe("validate-deny-commands", () => {
  it("collects built-in node commands", () => {
    const known = collectAllKnownNodeCommands({});
    expect(known.has("system.run")).toBe(true);
    expect(known.has("canvas.present")).toBe(true);
    expect(known.has("camera.snap")).toBe(true);
  });

  it("treats custom allowCommands entries as known", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        nodes: {
          allowCommands: ["custom.mycommand"],
        },
      },
    };

    const result = validateDenyCommandEntries(["custom.mycommand"], cfg);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("allows exact custom command ids that contain spaces", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        nodes: {
          allowCommands: ["my command"],
        },
      },
    };

    expect(looksLikeCommandPattern("my command")).toBe(false);
    expect(validateDenyCommandEntries(["my command"], cfg)).toEqual({ valid: true, errors: [] });
  });

  it("does not crash when allowCommands is malformed", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        nodes: {
          allowCommands: 42 as unknown as string[],
        },
      },
    };

    expect(() => validateDenyCommandEntries(["system.run"], cfg)).not.toThrow();
    expect(validateDenyCommandEntries(["system.run"], cfg)).toEqual({ valid: true, errors: [] });
  });

  it("ignores non-string allowCommands entries during validation", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        nodes: {
          allowCommands: [42, null, "custom.mycommand"] as unknown as string[],
        },
      },
    };

    const result = validateDenyCommandEntries(["custom.mycommand"], cfg);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("does not crash when gateway.nodes has a malformed shape", () => {
    const cfg = {
      gateway: {
        nodes: "broken" as unknown,
      },
    } as OpenClawConfig;

    expect(() => validateDenyCommandEntries(["system.run"], cfg)).not.toThrow();
  });

  it("rejects typos with a suggestion", () => {
    const result = validateDenyCommandEntries(["system.rn"], {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Did you mean "system.run"');
  });

  it("does not suggest commands beyond the max distance", () => {
    const result = validateDenyCommandEntries(["system.zzzzzz"], {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]).not.toContain('Did you mean "');
  });

  it("shows namespace-matched examples for unknown commands", () => {
    const result = validateDenyCommandEntries(["camera.zzzzzz"], {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("camera.list");
    expect(result.errors[0]).not.toContain("canvas.present");
  });

  it("detects pattern-like denyCommands entries", () => {
    expect(looksLikeCommandPattern("system.*")).toBe(true);
    const result = validateDenyCommandEntries(["system.*"], {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("exact matching");
  });
});
