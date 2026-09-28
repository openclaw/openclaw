// Exec policy CLI tests cover execution policy command behavior and persistence.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolAccessDiagnostics } from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentEntryConfig } from "../config/types.agents.js";
import { SESSION_EXEC_OVERRIDES_NOTE } from "../infra/exec-approvals-effective.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "../infra/exec-approvals.js";
import { registerExecPolicyCli } from "./exec-policy-cli.js";

function mockRollbackApprovalSnapshots(originalSnapshot: ExecApprovalsSnapshot) {
  mocks.setApprovalsHash(originalSnapshot.hash);
  mocks.readExecApprovalsSnapshot.mockImplementationOnce(() => originalSnapshot);
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function readLastJsonWrite(): Record<string, unknown> {
  const calls = mocks.defaultRuntime.writeJson.mock.calls;
  const [payload, space] = calls[calls.length - 1] ?? [];
  expect(space).toBe(0);
  if (!payload || typeof payload !== "object") {
    throw new Error("expected JSON write payload object");
  }
  return payload as Record<string, unknown>;
}

function readFirstPolicyScope(payload: Record<string, unknown>): Record<string, unknown> {
  const effectivePolicy = payload.effectivePolicy as { scopes?: unknown[] } | undefined;
  expect(Array.isArray(effectivePolicy?.scopes)).toBe(true);
  const scope = effectivePolicy?.scopes?.[0];
  if (!scope || typeof scope !== "object") {
    throw new Error("expected first policy scope object");
  }
  return scope as Record<string, unknown>;
}

function readFirstReplaceConfigArg(): Record<string, unknown> {
  const call = mocks.replaceConfigFile.mock.calls[0];
  if (!call) {
    throw new Error("expected replaceConfigFile call");
  }
  const arg = call[0];
  if (!arg || typeof arg !== "object") {
    throw new Error("expected replaceConfigFile argument");
  }
  return arg as Record<string, unknown>;
}

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  let configState: OpenClawConfig = {};
  let approvalsState: ExecApprovalsFile = { version: 1 };
  let approvalsHash = "approvals-hash";
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    getConfig: () => configState,
    setConfig: (next: OpenClawConfig) => {
      configState = next;
    },
    getApprovals: () => approvalsState,
    setApprovals: (next: ExecApprovalsFile) => {
      approvalsState = next;
    },
    setApprovalsHash: (next: string) => {
      approvalsHash = next;
    },
    defaultRuntime,
    runtimeErrors,
    callGateway: vi.fn(),
    replaceConfigFile: vi.fn(
      async ({ nextConfig }: { nextConfig: OpenClawConfig; baseHash?: string }) => {
        configState = structuredClone(nextConfig);
        return {
          path: "/tmp/openclaw.json",
          previousHash: "hash-1",
          persistedHash: "hash-1",
          snapshot: { path: "/tmp/openclaw.json" },
          nextConfig,
        };
      },
    ),
    readConfigFileSnapshot: vi.fn<
      () => Promise<{ path: string; hash: string; config: OpenClawConfig }>
    >(async () => ({
      path: "/tmp/openclaw.json",
      hash: "config-hash-1",
      config: configState,
    })),
    readExecApprovalsSnapshot: vi.fn<() => ExecApprovalsSnapshot>(() => ({
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: "{}",
      hash: approvalsHash,
      file: approvalsState,
    })),
    restoreExecApprovalsSnapshot: vi.fn(
      async (snapshot: ExecApprovalsSnapshot, baseHash: string) => {
        if (baseHash !== approvalsHash) {
          return false;
        }
        approvalsState = snapshot.file;
        approvalsHash = snapshot.hash;
        return true;
      },
    ),
    updateExecApprovals: vi.fn(
      async ({
        baseHash,
        update,
      }: {
        baseHash?: string;
        update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
      }) => {
        if (baseHash !== undefined && baseHash !== approvalsHash) {
          return null;
        }
        const next = update(structuredClone(approvalsState));
        if (next !== null) {
          approvalsState = next;
          approvalsHash = "written-approvals-hash";
        }
        return {
          path: "/tmp/exec-approvals.json",
          exists: true,
          raw: JSON.stringify(approvalsState),
          hash: approvalsHash,
          file: approvalsState,
        } satisfies ExecApprovalsSnapshot;
      },
    ),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: mocks.readExecApprovalsSnapshot,
    restoreExecApprovalsSnapshotLocked: mocks.restoreExecApprovalsSnapshot,
    updateExecApprovals: mocks.updateExecApprovals,
  };
});

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return { ...actual, callGatewayFromCliWithTransport: mocks.callGateway };
});

describe("exec-policy CLI", () => {
  const runExecPolicyCommand = async (args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerExecPolicyCli(program);
    await program.parseAsync(args, { from: "user" });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mocks.setConfig({
      tools: {
        exec: {
          host: "auto",
          mode: "ask",
        },
      },
    });
    mocks.setApprovals({
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
      },
      agents: {},
    });
    mocks.setApprovalsHash("approvals-hash");
    mocks.runtimeErrors.length = 0;
    mocks.callGateway.mockReset();
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.replaceConfigFile.mockReset();
    mocks.replaceConfigFile.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig; baseHash?: string }) => {
        mocks.setConfig(structuredClone(nextConfig));
        return {
          path: "/tmp/openclaw.json",
          previousHash: "hash-1",
          persistedHash: "hash-1",
          snapshot: { path: "/tmp/openclaw.json" },
          nextConfig,
        };
      },
    );
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockImplementation(async () => ({
      path: "/tmp/openclaw.json",
      hash: "config-hash-1",
      config: mocks.getConfig(),
    }));
    mocks.readExecApprovalsSnapshot.mockReset();
    mocks.readExecApprovalsSnapshot.mockImplementation(() => ({
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: "{}",
      hash: "approvals-hash",
      file: mocks.getApprovals(),
    }));
    mocks.restoreExecApprovalsSnapshot.mockReset();
    mocks.restoreExecApprovalsSnapshot.mockImplementation(
      async (snapshot: ExecApprovalsSnapshot, baseHash: string) => {
        if (baseHash !== "written-approvals-hash") {
          return false;
        }
        mocks.setApprovals(structuredClone(snapshot.file));
        mocks.setApprovalsHash(snapshot.hash);
        return true;
      },
    );
    mocks.updateExecApprovals.mockClear();
  });

  it("shows the local merged exec policy as json", async () => {
    await runExecPolicyCommand(["exec-policy", "show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    const payload = readLastJsonWrite();
    const effectivePolicy = payload.effectivePolicy as { note?: unknown } | undefined;
    expect(String(effectivePolicy?.note)).toContain(SESSION_EXEC_OVERRIDES_NOTE);
    expectFields(payload, {
      configPath: "/tmp/openclaw.json",
      approvalsPath: "/tmp/exec-approvals.json",
    });
    const scope = readFirstPolicyScope(payload);
    expectFields(scope, { scopeLabel: "tools.exec" });
    expectFields(scope.security, {
      requested: "allowlist",
      host: "allowlist",
      effective: "allowlist",
    });
    expectFields(scope.ask, {
      requested: "on-miss",
      host: "on-miss",
      effective: "on-miss",
    });
  });

  it("explains an agent profile override offline without changing permissions", async () => {
    const config: OpenClawConfig = {
      tools: { profile: "full", exec: { host: "gateway", mode: "ask" } },
      agents: { entries: { main: { tools: { profile: "messaging" } } } },
    };
    mocks.setConfig(config);

    await runExecPolicyCommand(["exec-policy", "show"]);

    const output = stripAnsi(mocks.defaultRuntime.log.mock.calls.flat().join("\n"));
    expect(output).toContain("TERMINAL ACCESS · main — OFF");
    expect(output).toContain("Global: full");
    expect(output).toContain("└─ Agent: messaging ← active");
    expect(output).toContain("exec: Excluded by policy");
    expect(output).toContain("process: Excluded by policy");
    expect(output).toContain("agents.entries.main.tools.profile");
    expect(output).toContain("agents.entries.main.tools.alsoAllow");
    expect(output).toContain("COMMAND APPROVALS (LOCAL)");
    expect(output).toContain("Based on: local configuration");
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.updateExecApprovals).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.getConfig()).toEqual(config);
  });

  it("does not present a partially allowed configuration as execution access", async () => {
    mocks.setConfig({
      agents: { entries: { main: { tools: { profile: "messaging", alsoAllow: ["exec"] } } } },
    });

    await runExecPolicyCommand(["exec-policy", "show", "--agent", "main"]);

    const output = stripAnsi(mocks.defaultRuntime.log.mock.calls.flat().join("\n"));
    expect(output).toContain("TERMINAL ACCESS · main — PARTIAL");
    expect(output).toContain("exec: Allowed by configuration; execution unverified");
    expect(output).toContain("process: Excluded by policy");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("keeps local findings when a session preview cannot be retrieved", async () => {
    mocks.setConfig({ agents: { entries: { main: { tools: { profile: "messaging" } } } } });
    mocks.callGateway.mockRejectedValueOnce(new Error("Gateway unreachable"));

    await runExecPolicyCommand(["exec-policy", "show", "--session", "agent:main:main"]);

    const output = stripAnsi(mocks.defaultRuntime.log.mock.calls.flat().join("\n"));
    expect(output).toContain("TERMINAL ACCESS · main — UNVERIFIED");
    expect(output).toContain("Local configuration excludes: exec, process");
    expect(output).toContain("Session preview: could not retrieve — Gateway unreachable");
    expect(output).toContain("agents.entries.main.tools.profile");
    expect(output).not.toContain("If terminal access is intended, append");
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, AgentEntryConfig>, string, boolean]>([
    ["qualified session absent locally", { main: {} }, "agent:remote:main", true],
    ["qualified session without local agents", {}, "agent:remote:main", false],
    ["shared session with multiple local agents", { main: {}, work: {} }, "global", true],
  ])("inspects a %s through the target Gateway", async (_name, entries, sessionKey, json) => {
    mocks.setConfig({ agents: { ownership: "explicit", entries } });
    mocks.callGateway.mockResolvedValueOnce({
      agentId: "remote",
      profile: "full",
      groups: [],
      toolAccess: {
        checked: "live-session",
        profiles: [{ profile: "full", source: "tools.profile", active: true }],
        tools: ["exec", "process"].map((id) => ({ id, status: "available", reasons: [] })),
      },
    });

    await runExecPolicyCommand([
      "exec-policy",
      "show",
      "--session",
      sessionKey,
      "--url",
      "ws://127.0.0.1:18790",
      ...(json ? ["--json"] : []),
    ]);

    expect(mocks.callGateway).toHaveBeenCalledWith(
      "tools.effective",
      expect.objectContaining({ url: "ws://127.0.0.1:18790" }),
      expect.objectContaining({ sessionKey }),
      expect.objectContaining({ sharedStateMode: "read-only" }),
    );
    if (json) {
      const payload = readLastJsonWrite();
      expect(payload.toolAccess).toMatchObject({
        agentId: "remote",
        live: {
          status: "verified",
          diagnostics: {
            tools: [
              { id: "exec", status: "available" },
              { id: "process", status: "available" },
            ],
          },
        },
      });
      expect(payload.toolAccess).not.toHaveProperty("local");
    } else {
      const output = stripAnsi(mocks.defaultRuntime.log.mock.calls.flat().join("\n"));
      expect(output).toContain("TERMINAL ACCESS · remote — PREVIEW");
      expect(output).toContain("exec: Included in session preview");
      expect(output).toContain("Local tool policy: unavailable");
      expect(output).not.toContain("Allowed by configuration");
    }
    expect(mocks.updateExecApprovals).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("does not fabricate local allowances when a remote-only session preview fails", async () => {
    mocks.setConfig({ agents: { ownership: "explicit", entries: { main: {} } } });
    mocks.callGateway.mockRejectedValueOnce(new Error("Gateway unreachable"));

    await runExecPolicyCommand([
      "exec-policy",
      "show",
      "--session",
      "agent:remote:main",
      "--url",
      "ws://127.0.0.1:18790",
    ]);

    const output = stripAnsi(mocks.defaultRuntime.log.mock.calls.flat().join("\n"));
    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(output).toContain("UNVERIFIED");
    expect(output).toContain("Gateway unreachable");
    expect(output).toContain("Local tool policy: unavailable");
    expect(output).not.toMatch(/Local configuration allows|Allowed by configuration/);
  });

  it("rejects a preview returned for a different explicit session agent", async () => {
    mocks.setConfig({ agents: { entries: { main: {} } } });
    mocks.callGateway.mockResolvedValueOnce({ agentId: "other", profile: "full", groups: [] });

    await runExecPolicyCommand(["exec-policy", "show", "--session", "agent:main:main", "--json"]);

    expect(readLastJsonWrite()).toMatchObject({
      toolAccess: {
        agentId: "main",
        live: { status: "unverified", error: expect.stringContaining("different agent") },
      },
    });
  });

  it.each([false, true])(
    "explains explicit session denials with legacy preview=%s",
    async (legacy) => {
      mocks.callGateway.mockResolvedValueOnce({
        agentId: "main",
        profile: "full",
        groups: [
          {
            id: "runtime",
            tools: ["exec", "process"].map((id) => ({ id, deniedBySession: true })),
          },
        ],
        ...(!legacy && {
          toolAccess: {
            checked: "live-session",
            profiles: [{ profile: "full", source: "tools.profile", active: true }],
            tools: ["exec", "process"].map((id) => ({
              id,
              status: "excluded",
              reasons: [{ kind: "session", label: "Denied by this session's tool restrictions" }],
            })),
          },
        }),
      });

      await runExecPolicyCommand(["exec-policy", "show", "--session", "agent:main:main"]);

      const output = stripAnsi(mocks.defaultRuntime.log.mock.calls.flat().join("\n"));
      expect(output).toContain("TERMINAL ACCESS · main — BLOCKED");
      expect(output).toContain("Denied by this session's tool restrictions");
      expect(output).toContain("Based on: session preview (saved settings)");
      expect(output).toContain("COMMAND APPROVALS (LOCAL)");
      expect(output).not.toContain("If terminal access is intended, append");
      expect(mocks.callGateway).toHaveBeenCalledWith(
        "tools.effective",
        expect.objectContaining({ session: "agent:main:main" }),
        { agentId: "main", sessionKey: "agent:main:main" },
        expect.objectContaining({ sharedStateMode: "read-only" }),
      );
    },
  );

  it.each<{
    name: string;
    legacy?: boolean;
    tools: ToolAccessDiagnostics["tools"];
    status: string;
    finding: string;
  }>([
    {
      name: "included tools",
      tools: ["exec", "process"].map((id) => ({ id, status: "available", reasons: [] })),
      status: "PREVIEW",
      finding: "Included in session preview",
    },
    {
      name: "absent tools",
      legacy: true,
      tools: ["exec", "process"].map((id) => ({ id, status: "unavailable", reasons: [] })),
      status: "PREVIEW",
      finding: "Missing preview tools are not necessarily disabled",
    },
    {
      name: "one absent tool",
      tools: [
        { id: "exec", status: "available", reasons: [] },
        { id: "process", status: "unavailable", reasons: [] },
      ],
      status: "PREVIEW",
      finding: "process: Not included in session preview; execution unverified",
    },
    {
      name: "an exclusion alongside an unexplained absence",
      tools: [
        {
          id: "exec",
          status: "excluded",
          reasons: [{ kind: "profile", label: "messaging profile" }],
          alsoAllowPath: "agents.entries.main.tools.alsoAllow",
        },
        { id: "process", status: "unavailable", reasons: [] },
      ],
      status: "PARTIAL",
      finding: "Missing preview tools are not necessarily disabled",
    },
  ])(
    "does not turn $name into an execution claim or permission recipe",
    async ({ tools, status, finding, legacy }) => {
      mocks.callGateway.mockResolvedValueOnce({
        agentId: "main",
        profile: "full",
        groups: [],
        ...(!legacy && { toolAccess: { checked: "live-session", profiles: [], tools } }),
      });

      await runExecPolicyCommand(["exec-policy", "show", "--session", "agent:main:main"]);

      const output = stripAnsi(mocks.defaultRuntime.log.mock.calls.flat().join("\n"));
      expect(output).toContain(`TERMINAL ACCESS · main — ${status}`);
      expect(output).toContain(finding);
      expect(output).toContain("Based on: session preview (saved settings)");
      expect(output).toContain("execution in a run");
      expect(output).not.toContain("If terminal access is intended, append");
      expect(output).not.toContain("Terminal tools are available");
      expect(output).not.toContain("blocking policies");
    },
  );

  it.each<{
    name: string;
    entries: Record<string, AgentEntryConfig>;
    scopes: string[];
  }>([
    {
      name: "multiple agents",
      entries: { main: {}, work: {} },
      scopes: ["tools.exec", "agent:main", "agent:work"],
    },
    { name: "empty roster", entries: {}, scopes: ["tools.exec"] },
  ])("preserves no-target approval JSON with $name", async ({ entries, scopes }) => {
    mocks.setConfig({ agents: { ownership: "explicit", entries } });

    await runExecPolicyCommand(["exec-policy", "show", "--json"]);

    const payload = readLastJsonWrite();
    expect(payload).toMatchObject({
      configPath: "/tmp/openclaw.json",
      approvalsPath: "/tmp/exec-approvals.json",
      approvalsExists: true,
      effectivePolicy: {
        scopes: scopes.map((scopeLabel) => expect.objectContaining({ scopeLabel })),
      },
      toolAccessSelectionRequired: {
        agentIds: Object.keys(entries),
        hint: expect.any(String),
      },
    });
    expect(payload).not.toHaveProperty("toolAccess");
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    entries: Record<string, AgentEntryConfig>;
    status: string;
    hint: string;
    scopes: Array<{ label: string; facts: string[] }>;
  }>([
    {
      name: "multiple agents",
      entries: {
        main: { tools: { exec: { mode: "deny" } } },
        work: { tools: { exec: { host: "node", mode: "full" } } },
      },
      status: "SELECT AGENT",
      hint: "Pass --agent <id>",
      scopes: [
        { label: "tools.exec", facts: ["gateway", "allowlist", "ask on miss", "fallback deny"] },
        { label: "agent:main", facts: ["gateway", "deny", "ask on miss", "fallback deny"] },
        { label: "agent:work", facts: ["node", "unknown", "fallback unknown"] },
      ],
    },
    {
      name: "no configured agents",
      entries: {},
      status: "NO AGENT CONFIGURED",
      hint: "openclaw agents add",
      scopes: [
        { label: "tools.exec", facts: ["gateway", "allowlist", "ask on miss", "fallback deny"] },
      ],
    },
  ])(
    "keeps compact approval facts in an untargeted report with $name",
    async ({ entries, status, hint, scopes }) => {
      mocks.setConfig({
        tools: { exec: { host: "gateway", mode: "ask" } },
        agents: { ownership: "explicit", entries },
      });

      await runExecPolicyCommand(["exec-policy", "show"]);

      const output = stripAnsi(mocks.defaultRuntime.log.mock.calls.flat().join("\n"));
      expect(output).toContain(`TERMINAL ACCESS — ${status}`);
      expect(output).toContain(hint);
      expect(output).toContain("COMMAND APPROVALS (LOCAL)");
      for (const scope of scopes) {
        const line = output.split("\n").find((candidate) => candidate.includes(scope.label));
        for (const fact of scope.facts) {
          expect(line, scope.label).toContain(fact);
        }
      }
      expect(output).not.toMatch(/Requested|Effective Policy/);
      expect(output).toContain("--verbose");
      expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    { args: ["--agent", "missing"], error: "Unknown agent id" },
    { args: ["--agent", "main", "--session", "agent:work:main"], error: "does not match" },
  ])("rejects an invalid explicit target: $args", async ({ args, error }) => {
    mocks.setConfig({ agents: { entries: { main: {}, work: {} } } });

    await expect(runExecPolicyCommand(["exec-policy", "show", ...args])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.runtimeErrors.join("\n")).toContain(error);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("renders an unstored fresh-install policy as defaults instead of missing", async () => {
    mocks.readExecApprovalsSnapshot.mockImplementationOnce(() => ({
      path: "~/.openclaw/state/openclaw.sqlite#exec_approvals_config",
      exists: false,
      raw: null,
      hash: "missing-hash",
      file: { version: 1, agents: {} },
    }));

    await runExecPolicyCommand(["exec-policy", "show"]);

    const output = stripAnsi(
      mocks.defaultRuntime.log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"),
    );
    expect(output).toContain("Approvals State");
    expect(output).toContain("defaults (no stored overrides)");
    expect(output).not.toContain("Approvals File");
    expect(output).not.toContain("missing");
  });

  it("marks host=node scopes as node-managed in show output", async () => {
    mocks.setConfig({
      tools: {
        exec: {
          host: "node",
          mode: "ask",
        },
      },
    });

    await runExecPolicyCommand(["exec-policy", "show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    const payload = readLastJsonWrite();
    const effectivePolicy = payload.effectivePolicy as { note?: unknown } | undefined;
    expect(String(effectivePolicy?.note)).toContain("host=node");
    const scope = readFirstPolicyScope(payload);
    expectFields(scope, {
      scopeLabel: "tools.exec",
      runtimeApprovalsSource: "node-runtime",
    });
    expectFields(scope.security, {
      requested: "allowlist",
      host: "unknown",
      effective: "unknown",
      hostSource: "node runtime approvals",
    });
    expectFields(scope.ask, {
      requested: "on-miss",
      host: "unknown",
      effective: "unknown",
      hostSource: "node runtime approvals",
    });
    expectFields(scope.askFallback, {
      effective: "unknown",
      source: "node runtime approvals",
    });
    expect(scope).not.toHaveProperty("allowedDecisions");
  });

  it("applies the yolo preset to both config and approvals", async () => {
    await runExecPolicyCommand(["exec-policy", "preset", "yolo", "--json"]);

    expect(mocks.getConfig().tools?.exec).toEqual({
      host: "gateway",
      mode: "full",
    });
    expect(mocks.getApprovals().defaults).toEqual({
      security: "full",
      ask: "off",
      askFallback: "full",
    });
    const replaceConfigArg = readFirstReplaceConfigArg();
    expectFields(replaceConfigArg, { baseHash: "config-hash-1" });
    expect(mocks.updateExecApprovals).toHaveBeenCalledTimes(1);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
  });

  it("sets explicit values without requiring a preset", async () => {
    await runExecPolicyCommand([
      "exec-policy",
      "set",
      "--host",
      "gateway",
      "--security",
      "full",
      "--ask",
      "off",
      "--ask-fallback",
      "allowlist",
      "--json",
    ]);

    expect(mocks.getConfig().tools?.exec).toEqual({
      host: "gateway",
      mode: "full",
    });
    expect(mocks.getApprovals().defaults).toEqual({
      security: "full",
      ask: "off",
      askFallback: "allowlist",
    });
  });

  it("derives partial updates from retained legacy config policy", async () => {
    mocks.setConfig({ tools: { exec: { security: "deny", ask: "always" } } });

    await runExecPolicyCommand(["exec-policy", "set", "--ask", "off", "--json"]);

    expect(mocks.getConfig().tools?.exec).toEqual({ mode: "deny" });
  });

  it("retains nonrepresentable always-ask policy updates", async () => {
    mocks.setConfig({ tools: { exec: { mode: "full" } } });

    await runExecPolicyCommand(["exec-policy", "set", "--ask", "always", "--json"]);

    expect(mocks.getConfig().tools?.exec).toEqual({ security: "full", ask: "always" });
  });

  it("sanitizes terminal control content before rendering the text table", async () => {
    mocks.setConfig({
      tools: {
        exec: {
          host: "auto",
          mode: "ask",
        },
      },
    });
    mocks.readConfigFileSnapshot.mockImplementationOnce(async () => ({
      path: "/tmp/openclaw.json\u001B[2J\nforged",
      hash: "config-hash-1",
      config: mocks.getConfig(),
    }));
    mocks.readExecApprovalsSnapshot.mockImplementationOnce(() => ({
      path: "/tmp/exec-approvals.json\u0007\nforged",
      exists: true,
      raw: "{}",
      hash: "approvals-hash",
      file: {
        version: 1,
        defaults: {
          security: "full",
          ask: "off",
          askFallback: "full",
        },
        agents: {
          "scope\u200Bname": {
            security: "allowlist",
            ask: "on-miss",
            askFallback: "deny",
          },
        },
      },
    }));

    await runExecPolicyCommand(["exec-policy", "show", "--verbose"]);

    const output = stripAnsi(
      mocks.defaultRuntime.log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"),
    );
    expect(output).toContain("/tmp/openclaw.json");
    expect(output).toContain("/tmp/exec-approvals.json");
    expect(output).toContain("scope\\u{200B}name");
    expect(output).toContain("host=auto");
    expect(output).toContain("tools.exec.");
    expect(output).toContain("host)");
    expect(output).toContain(SESSION_EXEC_OVERRIDES_NOTE);
    expect(output).toContain("\\nforged");
    expect(output).not.toContain("/tmp/openclaw.json\nforged");
    expect(output).not.toContain("\u001B[2J");
    expect(output).not.toContain("\u0007");
  });

  it("reports invalid input once and exits once", async () => {
    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "nope"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.defaultRuntime.error).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeErrors).toEqual(["Invalid exec security: nope"]);
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledTimes(1);
  });

  it("rejects host=node for the local-only sync path", async () => {
    await expect(runExecPolicyCommand(["exec-policy", "set", "--host", "node"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.runtimeErrors).toEqual([
      "Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.",
    ]);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.updateExecApprovals).not.toHaveBeenCalled();
  });

  it("rejects sync when the resulting requested host remains node", async () => {
    mocks.setConfig({
      tools: {
        exec: {
          host: "node",
          mode: "ask",
        },
      },
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.runtimeErrors).toEqual([
      "Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.",
    ]);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.updateExecApprovals).not.toHaveBeenCalled();
  });

  it("rolls back approvals if the config write fails after approvals save", async () => {
    const originalApprovals = structuredClone(mocks.getApprovals());
    const originalRaw = JSON.stringify(originalApprovals, null, 2);
    const originalSnapshot: ExecApprovalsSnapshot = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: originalRaw,
      hash: "approvals-hash",
      file: originalApprovals,
    };
    mockRollbackApprovalSnapshots(originalSnapshot);
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.updateExecApprovals).toHaveBeenCalledTimes(1);
    expect(mocks.restoreExecApprovalsSnapshot).toHaveBeenCalledWith(
      originalSnapshot,
      "written-approvals-hash",
    );
    expect(mocks.getApprovals()).toEqual(originalApprovals);
    expect(mocks.runtimeErrors).toEqual(["config write failed"]);
  });

  it("removes a newly-written approvals file when config replacement fails and the original file was missing", async () => {
    const missingSnapshot: ExecApprovalsSnapshot = {
      path: "/tmp/missing-exec-approvals.json",
      exists: false,
      raw: null,
      hash: "approvals-hash",
      file: { version: 1, agents: {} },
    };
    mockRollbackApprovalSnapshots(missingSnapshot);
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.restoreExecApprovalsSnapshot).toHaveBeenCalledWith(
      missingSnapshot,
      "written-approvals-hash",
    );
  });

  it("rebases rollback over a newer approvals write", async () => {
    const originalApprovals = structuredClone(mocks.getApprovals());
    const originalRaw = JSON.stringify(originalApprovals, null, 2);
    const originalSnapshot = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: originalRaw,
      hash: "original-hash",
      file: originalApprovals,
    };
    mockRollbackApprovalSnapshots(originalSnapshot);
    mocks.restoreExecApprovalsSnapshot.mockImplementationOnce(async () => {
      const concurrentFile = structuredClone(mocks.getApprovals());
      concurrentFile.defaults = {
        ...concurrentFile.defaults,
        security: "deny",
      };
      concurrentFile.agents = {
        ...concurrentFile.agents,
        worker: { security: "deny" },
      };
      mocks.setApprovals(concurrentFile);
      mocks.setApprovalsHash("concurrent-write-hash");
      return false;
    });
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(runExecPolicyCommand(["exec-policy", "preset", "yolo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.restoreExecApprovalsSnapshot).toHaveBeenCalledWith(
      originalSnapshot,
      "written-approvals-hash",
    );
    expect(mocks.updateExecApprovals).toHaveBeenCalledTimes(2);
    expect(mocks.getApprovals()).toEqual({
      ...originalApprovals,
      defaults: {
        ...originalApprovals.defaults,
        security: "deny",
      },
      agents: {
        ...originalApprovals.agents,
        worker: { security: "deny" },
      },
    });
    expect(mocks.runtimeErrors).toEqual(["config write failed"]);
  });

  it("does not loosen a same-valued concurrent policy after rollback loses provenance", async () => {
    const originalApprovals: ExecApprovalsFile = {
      version: 1,
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
      },
      agents: {},
    };
    mocks.setApprovals(originalApprovals);
    const originalSnapshot = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: JSON.stringify(originalApprovals, null, 2),
      hash: "original-hash",
      file: originalApprovals,
    };
    mockRollbackApprovalSnapshots(originalSnapshot);
    mocks.restoreExecApprovalsSnapshot.mockImplementationOnce(async () => {
      const concurrentFile = structuredClone(mocks.getApprovals());
      concurrentFile.agents = { worker: { security: "deny" } };
      mocks.setApprovals(concurrentFile);
      mocks.setApprovalsHash("concurrent-write-hash");
      return false;
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config write failed"));

    await expect(runExecPolicyCommand(["exec-policy", "preset", "cautious"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.updateExecApprovals).toHaveBeenCalledTimes(2);
    expect(mocks.getApprovals()).toEqual({
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
      },
      agents: { worker: { security: "deny" } },
    });
    expect(mocks.runtimeErrors).toEqual(["config write failed"]);
  });

  it("clears an applied default that was originally unset during rebased rollback", async () => {
    const originalApprovals: ExecApprovalsFile = {
      version: 1,
      defaults: {
        ask: "on-miss",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agents: {},
    };
    mocks.setApprovals(originalApprovals);
    const originalSnapshot = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: JSON.stringify(originalApprovals, null, 2),
      hash: "original-hash",
      file: originalApprovals,
    };
    mockRollbackApprovalSnapshots(originalSnapshot);
    mocks.restoreExecApprovalsSnapshot.mockImplementationOnce(async () => {
      const concurrentFile = structuredClone(mocks.getApprovals());
      concurrentFile.defaults = {
        ...concurrentFile.defaults,
        autoAllowSkills: true,
      };
      mocks.setApprovals(concurrentFile);
      mocks.setApprovalsHash("concurrent-write-hash");
      return false;
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config write failed"));

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.getApprovals().defaults).toEqual({
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: true,
      security: undefined,
    });
    expect(mocks.runtimeErrors).toEqual(["config write failed"]);
  });

  it("reports when field-level rollback cannot be persisted", async () => {
    const originalApprovals = structuredClone(mocks.getApprovals());
    const originalSnapshot = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      raw: JSON.stringify(originalApprovals, null, 2),
      hash: "original-hash",
      file: originalApprovals,
    };
    mockRollbackApprovalSnapshots(originalSnapshot);
    mocks.restoreExecApprovalsSnapshot.mockImplementationOnce(async () => {
      mocks.setApprovalsHash("concurrent-write-hash");
      mocks.updateExecApprovals.mockRejectedValueOnce(new Error("approval rollback failed"));
      return false;
    });
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    await expect(
      runExecPolicyCommand(["exec-policy", "set", "--security", "full"]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.runtimeErrors).toEqual([
      "Config update failed: config write failed; exec approvals rollback failed: approval rollback failed",
    ]);
  });
});
