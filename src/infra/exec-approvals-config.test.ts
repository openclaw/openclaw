import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  parseLegacyExecApprovals,
  tryParsePersistedExecApprovals,
} from "./exec-approvals-config.js";
import { saveExecApprovals } from "./exec-approvals-store.test-support.js";
import { makeExecApprovalsTempDir } from "./exec-approvals-test-helpers.js";
import {
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
  it.each([false, true])("migrates default agent entries with main present=%s", (hasMain) => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        ...(hasMain
          ? { main: { ask: "always" as const, allowlist: [{ pattern: "/bin/main" }] } }
          : {}),
        default: {
          ...(hasMain ? { ask: "off" as const } : {}),
          allowlist: [{ pattern: "/bin/legacy" }],
        },
      },
    };
    const resolved = resolveExecApprovalsFromFile({ file, agentId: "main" });
    const patterns = hasMain ? ["/bin/main", "/bin/legacy"] : ["/bin/legacy"];
    expect(resolved.agent.ask).toBe(hasMain ? "always" : "off");
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(patterns);
    expect(resolved.file.agents?.main?.allowlist?.map((entry) => entry.pattern)).toEqual(patterns);
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
    expect(parsed.agents?.main?.allowlist).toMatchObject([
      { pattern: "ls" },
      { pattern: "cat", source: undefined },
    ]);
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

  it.each([false, true])("resolves invalid agent fields with null=%s", (isNull) => {
    const expected: ExecApprovalsAgent = {
      security: "deny",
      ask: isNull ? "always" : "on-miss",
      askFallback: "deny",
    };
    const other: ExecApprovalsAgent = {
      security: "full",
      ask: isNull ? "off" : "always",
      askFallback: "full",
    };
    const resolved = resolvePolicy(
      {
        security: isNull ? null : "foo",
        ask: isNull ? null : "Always",
        askFallback: isNull ? null : "bar",
      } as unknown as ExecApprovalsAgent,
      isNull ? other : expected,
      isNull ? expected : other,
    );
    expect(resolved.agent).toMatchObject(expected);
    const source = isNull ? "agents.*" : "defaults";
    expect(resolved.agentSources).toEqual({
      security: `${source}.security`,
      ask: `${source}.ask`,
      askFallback: `${source}.askFallback`,
    });
  });

  it.each([
    ["mixed entries", ["ls", { pattern: "/usr/bin/cat" }, "echo"], ["ls", "/usr/bin/cat", "echo"]],
    ["empty strings dropped", ["", "  ", "ls"], ["ls"]],
    [
      "malformed objects dropped",
      [{ pattern: "/usr/bin/ls" }, {}, { pattern: 123 }, { pattern: "   " }, "echo"],
      ["/usr/bin/ls", "echo"],
    ],
    ["non-array dropped", "ls", undefined],
  ] satisfies Array<[string, unknown, string[] | undefined]>)(
    "%s",
    (_, allowlist, expectedPatterns) => {
      const file = {
        version: 1,
        agents: { main: { allowlist } as ExecApprovalsAgent },
      } satisfies ExecApprovalsFile;
      const entries = normalizeExecApprovals(file).agents?.main?.allowlist;
      expect(entries?.map((entry) => entry.pattern)).toEqual(expectedPatterns);
      if (entries) {
        for (const entry of entries) {
          expect(entry).not.toHaveProperty("0");
        }
      }
    },
  );

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
