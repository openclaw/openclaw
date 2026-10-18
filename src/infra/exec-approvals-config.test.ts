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
  type ExecApprovalsFile,
} from "./exec-approvals.js";

describe("exec approvals config", () => {
  function parseLegacy(agents: unknown) {
    const parsed = parseLegacyExecApprovals(JSON.stringify({ version: 1, agents }));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.value;
  }

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
  const python = "/usr/bin/python3";
  const symlink = "/opt/homebrew/opt/python@3.14/bin/python3.14";
  const pythonGlob = "/opt/**/python*";
  it.each([
    ["python3", python, python, [python], python],
    ["python3", symlink, undefined, [pythonGlob], pythonGlob],
    ["unknown-tool", "/usr/local/bin/unknown-tool", undefined, [python, "/opt/**/node"], null],
  ] as const)(
    "matches resolved allowlist target %s at %s",
    (rawExecutable, resolvedPath, resolvedRealPath, patterns, expected) => {
      const resolution = {
        kind: "executable" as const,
        rawExecutable,
        resolvedPath,
        resolvedRealPath,
        executableName: resolvedPath.split("/").at(-1)!,
      };
      const entries = patterns.map((pattern) => ({ pattern }));
      expect(matchAllowlist(entries, resolution)?.pattern ?? null).toBe(expected);
    },
  );
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

  it("retains MCP grants when merging legacy default and canonical main policy", () => {
    const grant = {
      server: "project.docs",
      tool: "write_note",
      source: "allow-always",
      addedAt: 123,
    };
    const parsed = parseLegacy({ main: { mcpTools: [grant] }, default: { ask: "off" } });
    expect(parsed.agents?.main).toMatchObject({ mcpTools: [grant], ask: "off" });
    expect(parsed.agents?.default).toBeUndefined();
  });

  it("keeps legacy string allowlist entries while normalizing them", () => {
    const parsed = parseLegacy({
      main: { allowlist: ["  ls  ", { pattern: "cat", source: "legacy" }] },
    });
    expect(parsed.agents?.main?.allowlist?.[0]).toMatchObject({ pattern: "ls" });
    expect(parsed.agents?.main?.allowlist?.[1]).toEqual(
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
  function resolvePolicy(
    runner: ExecApprovalsAgent,
    defaults: ExecApprovalsAgent,
    wildcard: ExecApprovalsAgent,
  ) {
    return resolveExecApprovalsFromFile({
      file: { version: 1, defaults, agents: { "*": wildcard, runner } },
      agentId: "runner",
      overrides: { security: "full", ask: "off", askFallback: "full" },
    });
  }

  it("treats invalid explicit agent fields as masked and falls back to defaults instead of wildcard", () => {
    const resolved = resolvePolicy(
      {
        security: "foo" as unknown as ExecApprovalsAgent["security"],
        ask: "Always" as unknown as ExecApprovalsAgent["ask"],
        askFallback: "bar" as unknown as ExecApprovalsAgent["askFallback"],
      },
      { security: "deny", ask: "on-miss", askFallback: "deny" },
      { security: "full", ask: "always", askFallback: "full" },
    );

    expect(resolved.agent).toMatchObject({ security: "deny", ask: "on-miss", askFallback: "deny" });
    expect(resolved.agentSources).toEqual({
      security: "defaults.security",
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
    });
  });

  it("treats null explicit agent fields as unset and still considers wildcard", () => {
    const resolved = resolvePolicy(
      {
        security: null as unknown as ExecApprovalsAgent["security"],
        ask: null as unknown as ExecApprovalsAgent["ask"],
        askFallback: null as unknown as ExecApprovalsAgent["askFallback"],
      },
      { security: "full", ask: "off", askFallback: "full" },
      { security: "deny", ask: "always", askFallback: "deny" },
    );

    expect(resolved.agent).toMatchObject({ security: "deny", ask: "always", askFallback: "deny" });
    expect(resolved.agentSources).toEqual({
      security: "agents.*.security",
      ask: "agents.*.ask",
      askFallback: "agents.*.askFallback",
    });
  });

  it.each([
    {
      name: "mixed entries",
      allowlist: ["ls", { pattern: "/usr/bin/cat" }, "echo"],
      expectedPatterns: ["ls", "/usr/bin/cat", "echo"],
    },
    { name: "empty strings dropped", allowlist: ["", "  ", "ls"], expectedPatterns: ["ls"] },
    {
      name: "malformed objects dropped",
      allowlist: [{ pattern: "/usr/bin/ls" }, {}, { pattern: 123 }, { pattern: "   " }, "echo"],
      expectedPatterns: ["/usr/bin/ls", "echo"],
    },
    { name: "non-array dropped", allowlist: "ls", expectedPatterns: undefined },
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
    const entries = normalizeExecApprovals(file).agents?.main?.allowlist;
    expect(entries?.map((entry) => entry.pattern)).toEqual(expectedPatterns);
    if (entries) {
      for (const entry of entries) {
        expect(entry).not.toHaveProperty("0");
      }
    }
  });

  it("resolves to built-in defaults when invalid values are stripped", () => {
    const file = {
      version: 1,
      defaults: { security: "none", ask: "never" },
      agents: {
        "*": { security: "none", ask: "off" },
      },
    } as unknown as ExecApprovalsFile;
    const resolved = resolveExecApprovalsFromFile({ file, agentId: "main" });
    expect(resolved).toMatchObject({
      defaults: { security: "full", ask: "off" },
      agent: { security: "full", ask: "off" },
    });
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
    expect(normalized).toMatchObject({
      defaults: { security: undefined, ask: undefined, askFallback: undefined },
      agents: { main: { security: undefined, ask: undefined } },
    });
  });
});
