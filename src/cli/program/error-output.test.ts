// Error output tests cover program-level error display and exit messaging.
import { describe, expect, it } from "vitest";
import { formatCliParseErrorOutput, suggestClosestCommand } from "./error-output.js";

describe("formatCliParseErrorOutput", () => {
  it("explains unknown commands with root help and plugin hints", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'wat'\n", {
      argv: ["node", "openclaw", "wat"],
    });

    expect(output).toBe(
      'OpenClaw does not know the command "wat".\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("suggests the closest root command for a typo when knownCommands is provided (#83999)", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'upate'\n", {
      argv: ["node", "openclaw", "upate"],
      knownCommands: ["update", "doctor", "channels", "plugins"],
    });

    expect(output).toBe(
      'OpenClaw does not know the command "upate".\nDid you mean this?\n  openclaw update\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("surfaces the explicit alias for `upgrade` -> `update` (#83999)", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'upgrade'\n", {
      argv: ["node", "openclaw", "upgrade"],
      knownCommands: ["update", "doctor"],
    });

    expect(output).toContain("Did you mean this?\n  openclaw update");
  });

  it("does not suggest when the typo is far from every known command (#83999)", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'zzqwerty'\n", {
      argv: ["node", "openclaw", "zzqwerty"],
      knownCommands: ["update", "doctor", "channels"],
    });

    expect(output).not.toContain("Did you mean this?");
  });

  it("is a no-op when knownCommands is not provided (legacy caller shape)", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'upate'\n", {
      argv: ["node", "openclaw", "upate"],
    });

    expect(output).not.toContain("Did you mean this?");
  });

  it("points unknown options at the active command help", () => {
    const output = formatCliParseErrorOutput("error: unknown option '--wat'\n", {
      argv: ["node", "openclaw", "channels", "status", "--wat"],
    });

    expect(output).toBe(
      'OpenClaw does not recognize option "--wat".\nTry: openclaw channels status --help\n',
    );
  });

  it("points missing required arguments at command help", () => {
    const output = formatCliParseErrorOutput("error: missing required argument 'name'\n", {
      argv: ["node", "openclaw", "plugins", "install"],
    });

    expect(output).toBe(
      'Missing required argument "name".\nTry: openclaw plugins install --help\n',
    );
  });
});

describe("suggestClosestCommand (#83999)", () => {
  const known = ["update", "doctor", "channels", "plugins", "agents", "status"];

  it("picks the canonical update on `upate`", () => {
    expect(suggestClosestCommand("upate", known)).toBe("update");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(suggestClosestCommand("zzqwerty", known)).toBeUndefined();
  });

  it("honors the explicit upgrade -> update alias even when edit distance picks another", () => {
    // `upgrade` distance to `update` is 2 (`gr` -> `t`) — without the alias map
    // the Levenshtein-only path could ambiguously land on another short root.
    expect(suggestClosestCommand("upgrade", known)).toBe("update");
  });

  it("does not invent a command — alias target must be in knownCommands", () => {
    expect(suggestClosestCommand("upgrade", ["doctor", "channels"])).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(suggestClosestCommand("", known)).toBeUndefined();
    expect(suggestClosestCommand("   ", known)).toBeUndefined();
  });

  it("matches case-insensitively against known commands", () => {
    expect(suggestClosestCommand("DocTr", known)).toBe("doctor");
  });
});
