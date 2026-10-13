// Covers exec approval config normalization and safe-bin policy.
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  parseLegacyExecApprovals,
  tryParsePersistedExecApprovals,
} from "./exec-approvals-config.js";
import { saveExecApprovals } from "./exec-approvals-store.test-support.js";
import { makeExecApprovalsTempDir } from "./exec-approvals-test-helpers.js";
import {
  matchAllowlist,
  normalizeExecApprovals,
  resolveExecApprovalsLocked,
  resolveExecApprovalsFromFile,
  type ExecApprovalsAgent,
  type ExecAllowlistEntry,
  type ExecApprovalsFile,
} from "./exec-approvals.js";

describe("exec approvals wildcard agent", () => {
  it("merges wildcard allowlist entries with agent entries", async () => {
    const dir = makeExecApprovalsTempDir();
    const prevOpenClawHome = process.env.OPENCLAW_HOME;

    try {
      process.env.OPENCLAW_HOME = dir;
      saveExecApprovals({
        version: 1,
        agents: {
          "*": { allowlist: [{ pattern: "/bin/hostname" }] },
          main: { allowlist: [{ pattern: "/usr/bin/uname" }] },
        },
      });

      const resolved = await resolveExecApprovalsLocked("main");
      expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual([
        "/bin/hostname",
        "/usr/bin/uname",
      ]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (prevOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = prevOpenClawHome;
      }
    }
  });
});

describe("exec approvals node host allowlist check", () => {
  it.each([
    {
      resolution: {
        kind: "executable" as const,
        rawExecutable: "python3",
        resolvedPath: "/usr/bin/python3",
        resolvedRealPath: "/usr/bin/python3",
        executableName: "python3",
      },
      entries: [{ pattern: "/usr/bin/python3" }],
      expectedPattern: "/usr/bin/python3",
    },
    {
      // Simulates symlink resolution:
      // /opt/homebrew/bin/python3 -> /opt/homebrew/opt/python@3.14/bin/python3.14
      resolution: {
        kind: "executable" as const,
        rawExecutable: "python3",
        resolvedPath: "/opt/homebrew/opt/python@3.14/bin/python3.14",
        executableName: "python3.14",
      },
      entries: [{ pattern: "/opt/**/python*" }],
      expectedPattern: "/opt/**/python*",
    },
    {
      resolution: {
        kind: "executable" as const,
        rawExecutable: "unknown-tool",
        resolvedPath: "/usr/local/bin/unknown-tool",
        executableName: "unknown-tool",
      },
      entries: [{ pattern: "/usr/bin/python3" }, { pattern: "/opt/**/node" }],
      expectedPattern: null,
    },
  ])(
    "matches exact and wildcard allowlist patterns for %j",
    ({ resolution, entries, expectedPattern }) => {
      const match = matchAllowlist(entries, resolution);
      expect(match?.pattern ?? null).toBe(expectedPattern);
    },
  );
});

describe("exec approvals default agent migration", () => {
  it("migrates legacy default agent entries to main", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        default: { allowlist: [{ pattern: "/bin/legacy" }] },
      },
    };
    const resolved = resolveExecApprovalsFromFile({ file, agentId: "main" });
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(["/bin/legacy"]);
    expect(resolved.file.agents?.default).toBeUndefined();
    expect(resolved.file.agents?.main?.allowlist?.[0]?.pattern).toBe("/bin/legacy");
  });

  it("prefers main agent settings when both main and default exist", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: { ask: "always", allowlist: [{ pattern: "/bin/main" }] },
        default: { ask: "off", allowlist: [{ pattern: "/bin/legacy" }] },
      },
    };
    const resolved = resolveExecApprovalsFromFile({ file, agentId: "main" });
    expect(resolved.agent.ask).toBe("always");
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(["/bin/main", "/bin/legacy"]);
    expect(resolved.file.agents?.default).toBeUndefined();
  });
});

describe("exec approvals policy schemas", () => {
  it("retains MCP grants when merging legacy default and canonical main policy", () => {
    const grant = {
      server: "project.docs",
      tool: "write_note",
      source: "allow-always",
      addedAt: 123,
    };
    const parsed = parseLegacyExecApprovals(
      JSON.stringify({
        version: 1,
        agents: { main: { mcpTools: [grant] }, default: { ask: "off" } },
      }),
    );
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.value.agents?.main).toMatchObject({ mcpTools: [grant], ask: "off" });
    expect(parsed.value.agents?.default).toBeUndefined();
  });

  it("keeps legacy string allowlist entries while normalizing them", () => {
    const parsed = parseLegacyExecApprovals(
      JSON.stringify({
        version: 1,
        agents: { main: { allowlist: ["  ls  ", { pattern: "cat", source: "legacy" }] } },
      }),
    );
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.value.agents?.main?.allowlist?.[0]).toMatchObject({ pattern: "ls" });
    expect(parsed.value.agents?.main?.allowlist?.[1]).toEqual(
      expect.objectContaining({ pattern: "cat", source: undefined }),
    );
  });

  it.each([
    ...[
      { server: "", tool: "write_note", source: "allow-always", addedAt: 123 },
      { server: "project.docs", tool: "", source: "allow-always", addedAt: 123 },
      { server: "project.docs", tool: "write_note", source: "other", addedAt: 123 },
      { server: "project.docs", tool: "write_note", source: "allow-always", addedAt: -1 },
    ].map((grant, index) => ({
      name: `MCP grant ${index}`,
      value: { version: 1, agents: { main: { mcpTools: [grant] } } },
    })),
    { name: "version", value: { version: 2 } },
    { name: "socket token", value: { version: 1, socket: { token: 42 } } },
    { name: "policy enum", value: { version: 1, defaults: { security: "none" } } },
    ...["lastUsedAt", "lastUsedCommand"].map((field) => ({
      name: `null ${field}`,
      value: { version: 1, agents: { main: { allowlist: [{ pattern: "ls", [field]: null }] } } },
    })),
    {
      name: "allowlist metadata",
      value: {
        version: 1,
        agents: { main: { allowlist: [{ pattern: "ls", lastUsedAt: "now" }] } },
      },
    },
  ])("rejects invalid persisted $name", ({ value }) => {
    expect(tryParsePersistedExecApprovals(JSON.stringify(value))).toBeNull();
  });
});

describe("exec approvals invalid explicit policy fallback", () => {
  it("treats invalid explicit agent fields as masked and falls back to defaults instead of wildcard", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: {
        version: 1,
        defaults: {
          security: "deny",
          ask: "on-miss",
          askFallback: "deny",
        },
        agents: {
          "*": {
            security: "full",
            ask: "always",
            askFallback: "full",
          },
          runner: {
            security: "foo" as unknown as ExecApprovalsAgent["security"],
            ask: "Always" as unknown as ExecApprovalsAgent["ask"],
            askFallback: "bar" as unknown as ExecApprovalsAgent["askFallback"],
          },
        },
      },
      agentId: "runner",
      overrides: {
        security: "full",
        ask: "off",
        askFallback: "full",
      },
    });

    expect(resolved.agent.security).toBe("deny");
    expect(resolved.agent.ask).toBe("on-miss");
    expect(resolved.agent.askFallback).toBe("deny");
    expect(resolved.agentSources).toEqual({
      security: "defaults.security",
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
    });
  });

  it("treats null explicit agent fields as unset and still considers wildcard", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: {
        version: 1,
        defaults: {
          security: "full",
          ask: "off",
          askFallback: "full",
        },
        agents: {
          "*": {
            security: "deny",
            ask: "always",
            askFallback: "deny",
          },
          runner: {
            security: null as unknown as ExecApprovalsAgent["security"],
            ask: null as unknown as ExecApprovalsAgent["ask"],
            askFallback: null as unknown as ExecApprovalsAgent["askFallback"],
          },
        },
      },
      agentId: "runner",
      overrides: {
        security: "full",
        ask: "off",
        askFallback: "full",
      },
    });

    expect(resolved.agent.security).toBe("deny");
    expect(resolved.agent.ask).toBe("always");
    expect(resolved.agent.askFallback).toBe("deny");
    expect(resolved.agentSources).toEqual({
      security: "agents.*.security",
      ask: "agents.*.ask",
      askFallback: "agents.*.askFallback",
    });
  });
});

describe("normalizeExecApprovals handles string allowlist entries (#9790)", () => {
  function normalizeMainAllowlist(file: ExecApprovalsFile): ExecAllowlistEntry[] | undefined {
    const normalized = normalizeExecApprovals(file);
    return normalized.agents?.main?.allowlist;
  }

  function expectNoSpreadStringArtifacts(entries: ExecAllowlistEntry[]) {
    for (const entry of entries) {
      expect(entry).toHaveProperty("pattern");
      expect(typeof entry.pattern).toBe("string");
      expect(entry.pattern.length).toBeGreaterThan(0);
      expect(entry).not.toHaveProperty("0");
    }
  }

  it.each([
    {
      name: "mixed entries",
      allowlist: ["ls", { pattern: "/usr/bin/cat" }, "echo"],
      expectedPatterns: ["ls", "/usr/bin/cat", "echo"],
    },
    {
      name: "empty strings dropped",
      allowlist: ["", "  ", "ls"],
      expectedPatterns: ["ls"],
    },
    {
      name: "malformed objects dropped",
      allowlist: [{ pattern: "/usr/bin/ls" }, {}, { pattern: 123 }, { pattern: "   " }, "echo"],
      expectedPatterns: ["/usr/bin/ls", "echo"],
    },
    {
      name: "non-array dropped",
      allowlist: "ls",
      expectedPatterns: undefined,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    allowlist: unknown;
    expectedPatterns: string[] | undefined;
  }>)("$name", ({ allowlist, expectedPatterns }) => {
    const file = {
      version: 1,
      agents: {
        main: { allowlist } as ExecApprovalsAgent,
      },
    } satisfies ExecApprovalsFile;
    const entries = normalizeMainAllowlist(file);
    expect(entries?.map((entry) => entry.pattern)).toEqual(expectedPatterns);
    if (entries) {
      expectNoSpreadStringArtifacts(entries);
    }
  });
});

describe("normalizeExecApprovals strips invalid security/ask enum values (#59006)", () => {
  it("resolves to built-in defaults when invalid values are stripped", () => {
    const file = {
      version: 1,
      defaults: { security: "none", ask: "never" },
      agents: {
        "*": { security: "none", ask: "off" },
      },
    } as unknown as ExecApprovalsFile;
    const resolved = resolveExecApprovalsFromFile({ file, agentId: "main" });
    // Invalid "none" in defaults is stripped, so fallback to DEFAULT_SECURITY ("full")
    expect(resolved.defaults.security).toBe("full");
    // Invalid "never" in defaults is stripped, so fallback to DEFAULT_ASK ("off")
    expect(resolved.defaults.ask).toBe("off");
    // Wildcard agent "none" is stripped, so agent inherits resolved defaults
    expect(resolved.agent.security).toBe("full");
    // Wildcard agent ask="off" is valid and preserved
    expect(resolved.agent.ask).toBe("off");
  });

  it("strips non-string policy values (e.g. numbers, booleans) without throwing", () => {
    const file = {
      version: 1,
      defaults: { security: 1, ask: true, askFallback: ["deny"] },
      agents: {
        main: { security: 42, ask: false },
      },
    } as unknown as ExecApprovalsFile;
    const normalized = normalizeExecApprovals(file);
    expect(normalized.defaults?.security).toBeUndefined();
    expect(normalized.defaults?.ask).toBeUndefined();
    expect(normalized.defaults?.askFallback).toBeUndefined();
    expect(normalized.agents?.main?.security).toBeUndefined();
    expect(normalized.agents?.main?.ask).toBeUndefined();
  });
});
