// Plugin list format tests cover verbose installed plugin details.
import { Chalk } from "chalk";
import { describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { formatPluginLine } from "./plugins-list-format.js";

// mock-isolation: Force real ANSI styling independently of the test runner's NO_COLOR setting so trust color distinction is verifiable.
vi.mock("../../packages/terminal-core/src/theme.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/terminal-core/src/theme.js")>();
  const styled = new Chalk({ level: 1 });
  return {
    ...actual,
    theme: {
      ...actual.theme,
      success: styled.green,
      warn: styled.yellow,
      error: styled.red,
      muted: styled.gray,
      heading: styled.bold,
      command: styled.cyan,
    },
  };
});

describe("formatPluginLine", () => {
  it("labels active registry entries as enabled rather than loaded", () => {
    const output = formatPluginLine(createPluginRecord({ id: "demo", enabled: true }));

    expect(output).toContain("enabled");
    expect(output).not.toContain("loaded");
    expect(output).not.toContain("bundle capabilities:");
  });

  it("shows imported state in verbose output", () => {
    const output = formatPluginLine(
      createPluginRecord({
        id: "demo",
        name: "Demo Plugin",
        imported: false,
        activated: true,
        explicitlyEnabled: false,
      }),
    );

    expect(output).toContain("activated: yes");
    expect(output).toContain("imported: no");
    expect(output).toContain("explicitly enabled: no");
  });

  it("shows bundle subtype and detected capabilities", () => {
    const output = formatPluginLine(
      createPluginRecord({
        id: "portable",
        format: "bundle",
        bundleFormat: "agent",
        bundleCapabilities: ["skills", "mcpServers"],
      }),
    );

    expect(output).toContain("bundle format: agent (Agent Plugins)");
    expect(output).toContain("bundle capabilities: skills, mcpServers");
  });

  it("sanitizes activation reasons in verbose output", () => {
    const output = formatPluginLine(
      createPluginRecord({
        id: "demo",
        name: "Demo Plugin",
        activated: true,
        activationSource: "auto",
        activationReason: "\u001B[31mconfigured\nnext\tstep",
      }),
    );

    expect(output).toContain("activation reason: configured\\nnext\\tstep");
    expect(output).not.toContain("\u001B[31m");
    expect(output.match(/activation reason:/g)).toHaveLength(1);
  });

  it.each([
    { reason: "bundled" as const, kind: "trusted" },
    { reason: "trusted-official" as const, kind: "trusted" },
    { reason: "provenance-missing" as const, kind: "untrusted" },
    { reason: "install-path-mismatch" as const, kind: "untrusted" },
  ])("renders $reason in verbose output", ({ reason }) => {
    const output = formatPluginLine(
      createPluginRecord({
        id: "demo",
        name: "Demo Plugin",
        trust: { reason, registryPath: null, origin: "global" },
      }),
    );

    // The reason text survives in the trust line (ANSI-wrapped under forced color).
    expect(output).toMatch(new RegExp(`trust: .*${reason}`));
  });

  it("distinguishes trusted from untrusted styling under forced color", () => {
    const trusted = formatPluginLine(
      createPluginRecord({
        id: "demo",
        name: "Demo Plugin",
        trust: { reason: "trusted-official", registryPath: null, origin: "global" },
      }),
    );
    const untrusted = formatPluginLine(
      createPluginRecord({
        id: "demo",
        name: "Demo Plugin",
        trust: { reason: "provenance-missing", registryPath: null, origin: "global" },
      }),
    );
    const trustedLine = trusted.match(/^ {2}trust: .+$/m)?.[0] ?? "";
    const untrustedLine = untrusted.match(/^ {2}trust: .+$/m)?.[0] ?? "";
    // success = green, warn = yellow; both wrap the reason in an ANSI sequence.
    const esc = String.fromCharCode(27);
    expect(trustedLine).toContain(`${esc}[32m`);
    expect(untrustedLine).toContain(`${esc}[33m`);
    expect(trustedLine).not.toBe(untrustedLine);
  });

  it("omits trust line when no trust record exists", () => {
    const output = formatPluginLine(createPluginRecord({ id: "demo", name: "Demo Plugin" }));
    expect(output).not.toMatch(/trust:/);
  });
});
