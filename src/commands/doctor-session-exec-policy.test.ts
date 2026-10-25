import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals-core.js";
import { maxAsk, minSecurity } from "../infra/exec-approvals-policy.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

let state: OpenClawTestState | undefined;

afterEach(async () => {
  note.mockClear();
  await state?.cleanup();
  state = undefined;
});

function askOffCase(
  name: string,
  cfg: OpenClawConfig,
  security: ExecSecurity,
  expected: SessionEntry["permissionMode"],
  scope: { host?: SessionEntry["execHost"]; sandbox?: SessionEntry["sandbox"] } = {},
) {
  return {
    name,
    cfg,
    legacy: { execAsk: "off" },
    oldPolicy: { security, ask: "off" as const },
    expected,
    ...scope,
  };
}

const execConfig = (mode: ExecSecurity): OpenClawConfig => ({ tools: { exec: { mode } } });
const denyConfig = execConfig("deny");
const fullConfig = execConfig("full");
const allowlistConfig = execConfig("allowlist");

async function setup(cfg: OpenClawConfig = {}) {
  state = await createOpenClawTestState({ prefix: "openclaw-doctor-exec-policy-" });
  const config = { ...cfg, plugins: { enabled: false } };
  setRuntimeConfigSnapshot(config);
  return { config, env: state.env };
}

describe("doctor legacy session exec policy", () => {
  it.each<{
    name: string;
    cfg: OpenClawConfig;
    legacy: { execSecurity?: string; execAsk?: string };
    host?: SessionEntry["execHost"];
    sandbox?: SessionEntry["sandbox"];
    oldPolicy: { security: ExecSecurity; ask: ExecAsk };
    expected: SessionEntry["permissionMode"];
  }>([
    askOffCase("partial ask under global deny", denyConfig, "deny", "read-only"),
    askOffCase(
      "partial ask under agent deny overriding global full",
      {
        ...fullConfig,
        agents: { entries: { worker: { tools: { exec: { mode: "deny" } } } } },
      },
      "deny",
      "read-only",
    ),
    askOffCase("partial ask under allowlist config", allowlistConfig, "allowlist", "guarded"),
    askOffCase("partial ask under full config", fullConfig, "full", undefined),
    {
      name: "partial security inherits global ask always",
      cfg: { tools: { exec: { security: "full", ask: "always" } } },
      legacy: { execSecurity: "allowlist" },
      oldPolicy: { security: "allowlist", ask: "always" },
      expected: "read-only",
    },
    {
      name: "partial security inherits agent ask always",
      cfg: {
        ...fullConfig,
        agents: { entries: { worker: { tools: { exec: { ask: "always" } } } } },
      },
      legacy: { execSecurity: "full" },
      oldPolicy: { security: "full", ask: "always" },
      expected: "read-only",
    },
    askOffCase("partial ask in a required sandbox", {}, "deny", "read-only", {
      sandbox: "required",
    }),
    askOffCase("partial ask with unknown auto sandbox availability", {}, "deny", "read-only", {
      host: "auto",
    }),
    askOffCase("partial ask with explicit gateway and no config policy", {}, "full", undefined),
  ])("does not broaden $name", async ({ cfg, legacy, host, sandbox, oldPolicy, expected }) => {
    const { config, env } = await setup(cfg);
    const scope = { agentId: "worker", env, sessionKey: "agent:worker:exec-policy" };
    await replaceSessionEntry(scope, {
      sessionId: "legacy-policy",
      updatedAt: Date.now(),
      execHost: host ?? "gateway",
      ...(sandbox ? { sandbox } : {}),
      ...legacy,
    });
    await noteSessionTranscriptHealth({ cfg: config, env, shouldRepair: true });
    closeOpenClawAgentDatabasesForTest();
    const migrated = listSessionEntriesCore(scope)[0]?.entry;
    expect(migrated?.permissionMode).toBe(expected);
    expect(migrated).not.toHaveProperty("execSecurity");
    expect(migrated).not.toHaveProperty("execAsk");
    // Resolve the stored policy without a sandbox or approval floor masking a
    // broadened migration. These fixtures state the old effective pair explicitly.
    const resolved = resolveExecDefaults({
      cfg,
      agentId: scope.agentId,
      execApprovals: { version: 1 },
      sessionEntry: { execHost: "gateway", permissionMode: migrated?.permissionMode },
    });
    expect(minSecurity(resolved.security, oldPolicy.security)).toBe(resolved.security);
    if (resolved.security !== "deny") {
      expect(maxAsk(resolved.ask, oldPolicy.ask)).toBe(resolved.ask);
    }
  });

  it("migrates persisted restrictions without granting full access and reports each session once", async () => {
    const { config, env } = await setup();
    const policyCase = (
      name: string,
      execSecurity: string | undefined,
      execAsk: string | undefined,
      expected: SessionEntry["permissionMode"],
      existing?: SessionEntry["permissionMode"],
    ) => ({
      name,
      legacy: {
        ...(execSecurity === undefined ? {} : { execSecurity }),
        ...(execAsk === undefined ? {} : { execAsk }),
      },
      expected,
      existing,
    });
    const cases = [
      policyCase("deny", "deny", "off", "read-only"),
      policyCase("allowlist", "allowlist", "off", "guarded"),
      policyCase("ask", "allowlist", "on-miss", "guarded"),
      // No mode encodes approval for every command; retire ask=always to read-only.
      policyCase("always", "full", "always", "read-only"),
      policyCase("allowlist-always", "allowlist", "always", "read-only"),
      policyCase("partial-always", undefined, "always", "read-only"),
      policyCase("full", "full", "off", undefined),
      policyCase("full-on-miss", "full", "on-miss", undefined),
      policyCase("partial-full", "full", undefined, undefined),
      policyCase("partial-deny", "deny", undefined, "read-only"),
      policyCase("partial-ask", undefined, "on-miss", "read-only"),
      policyCase("partial-off", undefined, "off", "read-only"),
      policyCase("existing", "deny", undefined, "workspace", "workspace"),
      policyCase("canonical", undefined, undefined, "full", "full"),
    ];
    for (const testCase of cases) {
      const sessionKey = `agent:main:exec-policy-${testCase.name}`;
      const entry = {
        sessionId: `session-${testCase.name}`,
        updatedAt: Date.now(),
        execHost: "node",
        execNode: "bound-node",
        execCwd: "/workspace",
        sandbox: "required" as const,
        ...testCase.legacy,
        ...(testCase.existing ? { permissionMode: testCase.existing } : {}),
      };
      await replaceSessionEntry({ agentId: "main", env, sessionKey }, entry);
    }
    const run = (shouldRepair: boolean) =>
      noteSessionTranscriptHealth({ cfg: config, env, shouldRepair });
    const read = () => listSessionEntriesCore({ agentId: "main", env });
    const before = read();

    await run(false);
    expect(read()).toEqual(before);
    note.mockClear();

    await run(true);
    closeOpenClawAgentDatabasesForTest();
    const repaired = read();
    const lines = note.mock.calls.flatMap(([message]) => String(message).split("\n"));
    for (const testCase of cases) {
      const sessionKey = `agent:main:exec-policy-${testCase.name}`;
      const entry = repaired.find((row) => row.sessionKey === sessionKey)?.entry;
      expect(entry, testCase.name).toMatchObject({
        execHost: "node",
        execNode: "bound-node",
        execCwd: "/workspace",
        sandbox: "required",
      });
      expect(entry?.permissionMode, testCase.name).toBe(testCase.expected);
      expect(entry).not.toHaveProperty("execSecurity");
      expect(entry).not.toHaveProperty("execAsk");
      expect(lines.filter((line) => line.startsWith(`- ${sessionKey}:`))).toHaveLength(
        testCase.name === "canonical" ? 0 : 1,
      );
    }
    const output = lines.join("\n");
    expect(output).toContain("config default applies");
    expect(output).toContain("full permission mode was not granted");
    expect(output).toContain("ask=always has no mode equivalent");
    for (const name of ["always", "allowlist-always", "partial-always"]) {
      const migrated = repaired.find(
        (row) => row.sessionKey === `agent:main:exec-policy-${name}`,
      )?.entry;
      // Resolve the migrated mode alone: the fixture's sandbox binding would
      // deny on its own and make this assertion vacuous.
      const resolved = resolveExecDefaults({
        cfg: fullConfig,
        execApprovals: { version: 1 },
        sessionEntry: { permissionMode: migrated?.permissionMode },
      });
      expect(resolved.security, name).toBe("deny");
      expect(resolved.mode, name).toBe("deny");
    }
    note.mockClear();
    await run(true);
    expect(read()).toEqual(repaired);
    expect(note.mock.calls.some(([, title]) => title === "Session exec policy")).toBe(false);
  });
});
