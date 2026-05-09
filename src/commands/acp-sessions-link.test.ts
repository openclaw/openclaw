import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  acpSessionsLinkCommand,
  buildAcpSessionLinkRows,
  type AcpSessionLinkRow,
} from "./acp-sessions-link.js";

// Disable colors for deterministic output.
process.env.FORCE_COLOR = "0";

// ---------------------------------------------------------------------------
// Hoisted mocks for resolver routing tests
// ---------------------------------------------------------------------------
const targetsMocks = vi.hoisted(() => ({
  resolveAgentSessionStoreTargetsSync: vi.fn<[], []>().mockReturnValue([]),
  resolveAllAgentSessionStoreTargetsSync: vi.fn<[], []>().mockReturnValue([]),
}));

vi.mock("../config/sessions/targets.js", () => ({
  resolveAgentSessionStoreTargetsSync: targetsMocks.resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync: targetsMocks.resolveAllAgentSessionStoreTargetsSync,
}));

// ---------------------------------------------------------------------------
// Config mock — same pattern as sessions.test-helpers.ts
// ---------------------------------------------------------------------------
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    agents: {
      defaults: {
        model: { primary: "pi:opus" },
        models: { "pi:opus": {} },
      },
    },
  }),
  loadConfig: () => ({
    agents: {
      defaults: {
        model: { primary: "pi:opus" },
        models: { "pi:opus": {} },
      },
    },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(): { runtime: RuntimeEnv; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => errors.push(String(msg)),
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
    logs,
    errors,
  };
}

function writeTempStore(data: Record<string, unknown>): string {
  const file = path.join(
    os.tmpdir(),
    `acp-sessions-link-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

const BASE_ACP_ENTRY = {
  sessionId: "some-session-id",
  updatedAt: Date.now(),
  acp: {
    backend: "acpx",
    agent: "copilot",
    runtimeSessionName: "agent:copilot:acp:test-uuid",
    mode: "oneshot",
    state: "idle",
    lastActivityAt: Date.now(),
  },
};

// ---------------------------------------------------------------------------
// buildAcpSessionLinkRows unit tests
// ---------------------------------------------------------------------------

describe("buildAcpSessionLinkRows", () => {
  let tmpStore: string;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "acp-link-home-"));
  });

  afterEach(() => {
    if (tmpStore) {
      try {
        fs.rmSync(tmpStore, { force: true });
      } catch {}
    }
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {}
  });

  it("returns an empty array when the store has no ACP sessions", () => {
    tmpStore = writeTempStore({
      "+15555550123": {
        sessionId: "non-acp",
        updatedAt: Date.now(),
      },
    });

    const rows = buildAcpSessionLinkRows([{ storePath: tmpStore }], fakeHome);
    expect(rows).toHaveLength(0);
  });

  it("happy path: emits full triple when acpxSessionId is present and state dir exists", () => {
    const acpSessionId = "acp-session-abc-123";
    const stateDir = path.join(fakeHome, ".copilot", "session-state", acpSessionId);
    fs.mkdirSync(stateDir, { recursive: true });

    tmpStore = writeTempStore({
      "agent:copilot:acp:test-uuid": {
        ...BASE_ACP_ENTRY,
        acp: {
          ...BASE_ACP_ENTRY.acp,
          identity: {
            state: "resolved",
            acpxSessionId: acpSessionId,
            source: "status",
            lastUpdatedAt: Date.now(),
          },
        },
      },
    });

    const rows = buildAcpSessionLinkRows([{ storePath: tmpStore }], fakeHome);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.openclawKey).toBe("agent:copilot:acp:test-uuid");
    expect(row?.acpSessionId).toBe(acpSessionId);
    expect(row?.copilotStatePath).toBe(stateDir);
    expect(row?.copilotStateExists).toBe(true);
  });

  it("missing state: copilotStateExists is false when copilot state dir does not exist", () => {
    const acpSessionId = "acp-session-xyz-missing";
    // Do NOT create the state dir.

    tmpStore = writeTempStore({
      "agent:copilot:acp:missing-uuid": {
        ...BASE_ACP_ENTRY,
        acp: {
          ...BASE_ACP_ENTRY.acp,
          identity: {
            state: "resolved",
            acpxSessionId: acpSessionId,
            source: "status",
            lastUpdatedAt: Date.now(),
          },
        },
      },
    });

    const rows = buildAcpSessionLinkRows([{ storePath: tmpStore }], fakeHome);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.openclawKey).toBe("agent:copilot:acp:missing-uuid");
    expect(row?.acpSessionId).toBe(acpSessionId);
    expect(row?.copilotStatePath).toBe(
      path.join(fakeHome, ".copilot", "session-state", acpSessionId),
    );
    expect(row?.copilotStateExists).toBe(false);
  });

  it("no acpxSessionId: acpSessionId is null and state fields are null/false", () => {
    tmpStore = writeTempStore({
      "agent:copilot:acp:no-id": {
        ...BASE_ACP_ENTRY,
        // No identity sub-object at all.
      },
    });

    const rows = buildAcpSessionLinkRows([{ storePath: tmpStore }], fakeHome);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.openclawKey).toBe("agent:copilot:acp:no-id");
    expect(row?.acpSessionId).toBeNull();
    expect(row?.copilotStatePath).toBeNull();
    expect(row?.copilotStateExists).toBe(false);
  });

  it("skips entries without acp metadata", () => {
    tmpStore = writeTempStore({
      "agent:copilot:acp:with-acp": {
        ...BASE_ACP_ENTRY,
        acp: {
          ...BASE_ACP_ENTRY.acp,
          identity: {
            state: "resolved",
            acpxSessionId: "some-id",
            source: "status",
            lastUpdatedAt: Date.now(),
          },
        },
      },
      "agent:main:main": {
        sessionId: "no-acp",
        updatedAt: Date.now(),
        // no acp field
      },
    });

    const rows = buildAcpSessionLinkRows([{ storePath: tmpStore }], fakeHome);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.openclawKey).toBe("agent:copilot:acp:with-acp");
  });

  it("gracefully handles a missing or unreadable store file", () => {
    const missingStore = path.join(
      os.tmpdir(),
      `non-existent-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const rows = buildAcpSessionLinkRows([{ storePath: missingStore }], fakeHome);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// acpSessionsLinkCommand integration tests
// ---------------------------------------------------------------------------

describe("acpSessionsLinkCommand", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "acp-link-cmd-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {}
  });

  it("prints TSV header + row for a session with full triple (happy path)", async () => {
    const acpSessionId = "acp-cmd-test-123";
    const stateDir = path.join(fakeHome, ".copilot", "session-state", acpSessionId);
    fs.mkdirSync(stateDir, { recursive: true });

    const storePath = writeTempStore({
      "agent:copilot:acp:cmd-test": {
        ...BASE_ACP_ENTRY,
        acp: {
          ...BASE_ACP_ENTRY.acp,
          identity: {
            state: "resolved",
            acpxSessionId: acpSessionId,
            source: "status",
            lastUpdatedAt: Date.now(),
          },
        },
      },
    });

    const { runtime, logs } = makeRuntime();
    try {
      await acpSessionsLinkCommand({ store: storePath }, runtime);
    } finally {
      fs.rmSync(storePath, { force: true });
    }

    expect(logs[0]).toContain("openclaw-key");
    expect(logs[0]).toContain("acp-session-id");
    expect(logs[0]).toContain("copilot-state-path");
    expect(logs[0]).toContain("status");

    const dataRow = logs[1] ?? "";
    expect(dataRow).toContain("agent:copilot:acp:cmd-test");
    expect(dataRow).toContain(acpSessionId);
    expect(dataRow).toContain(stateDir);
    expect(dataRow).toContain("ok");
  });

  it("flags MISSING_STATE_DIR when copilot state dir is absent", async () => {
    const acpSessionId = "acp-cmd-missing-999";
    // Do NOT create the state directory.

    const storePath = writeTempStore({
      "agent:copilot:acp:missing-state": {
        ...BASE_ACP_ENTRY,
        acp: {
          ...BASE_ACP_ENTRY.acp,
          identity: {
            state: "resolved",
            acpxSessionId: acpSessionId,
            source: "status",
            lastUpdatedAt: Date.now(),
          },
        },
      },
    });

    const { runtime, logs } = makeRuntime();
    try {
      await acpSessionsLinkCommand({ store: storePath }, runtime);
    } finally {
      fs.rmSync(storePath, { force: true });
    }

    const dataRow = logs.find((l) => l.includes("agent:copilot:acp:missing-state")) ?? "";
    expect(dataRow).toContain(acpSessionId);
    expect(dataRow).toContain("MISSING_STATE_DIR");
  });

  it("flags MISSING_ACP_ID when no acpxSessionId is present", async () => {
    const storePath = writeTempStore({
      "agent:copilot:acp:no-id": BASE_ACP_ENTRY,
    });

    const { runtime, logs } = makeRuntime();
    try {
      await acpSessionsLinkCommand({ store: storePath }, runtime);
    } finally {
      fs.rmSync(storePath, { force: true });
    }

    const dataRow = logs.find((l) => l.includes("agent:copilot:acp:no-id")) ?? "";
    expect(dataRow).toContain("MISSING_ACP_ID");
  });

  it("outputs JSON when --json is passed", async () => {
    const acpSessionId = "acp-json-test";
    const stateDir = path.join(fakeHome, ".copilot", "session-state", acpSessionId);
    fs.mkdirSync(stateDir, { recursive: true });

    const storePath = writeTempStore({
      "agent:copilot:acp:json-test": {
        ...BASE_ACP_ENTRY,
        acp: {
          ...BASE_ACP_ENTRY.acp,
          identity: {
            state: "resolved",
            acpxSessionId: acpSessionId,
            source: "status",
            lastUpdatedAt: Date.now(),
          },
        },
      },
    });

    const { runtime, logs } = makeRuntime();
    try {
      await acpSessionsLinkCommand({ store: storePath, json: true }, runtime);
    } finally {
      fs.rmSync(storePath, { force: true });
    }

    const parsed = JSON.parse(logs[0] ?? "{}") as {
      count: number;
      sessions: AcpSessionLinkRow[];
    };
    expect(parsed.count).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    const row = parsed.sessions[0];
    expect(row?.openclawKey).toBe("agent:copilot:acp:json-test");
    expect(row?.acpSessionId).toBe(acpSessionId);
    expect(row?.copilotStateExists).toBe(true);
  });

  it("prints no-sessions message when store is empty or has no ACP entries", async () => {
    const storePath = writeTempStore({
      "+15555550123": { sessionId: "non-acp", updatedAt: Date.now() },
    });

    const { runtime, logs } = makeRuntime();
    try {
      await acpSessionsLinkCommand({ store: storePath }, runtime);
    } finally {
      fs.rmSync(storePath, { force: true });
    }

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("No ACP sessions found");
  });
});

// ---------------------------------------------------------------------------
// Agent filter routing — verify --agent uses the scoped resolver, not all-agents
// ---------------------------------------------------------------------------

describe("acpSessionsLinkCommand agent filter routing", () => {
  beforeEach(() => {
    targetsMocks.resolveAgentSessionStoreTargetsSync.mockClear();
    targetsMocks.resolveAllAgentSessionStoreTargetsSync.mockClear();
  });

  it("calls the scoped resolver when --agent is set (no --store)", async () => {
    const { runtime } = makeRuntime();
    await acpSessionsLinkCommand({ agent: "copilot" }, runtime);

    expect(targetsMocks.resolveAgentSessionStoreTargetsSync).toHaveBeenCalledOnce();
    expect(targetsMocks.resolveAgentSessionStoreTargetsSync).toHaveBeenCalledWith(
      expect.anything(),
      "copilot",
    );
    expect(targetsMocks.resolveAllAgentSessionStoreTargetsSync).not.toHaveBeenCalled();
  });

  it("calls the all-agents resolver when --agent is absent (no --store)", async () => {
    const { runtime } = makeRuntime();
    await acpSessionsLinkCommand({}, runtime);

    expect(targetsMocks.resolveAllAgentSessionStoreTargetsSync).toHaveBeenCalledOnce();
    expect(targetsMocks.resolveAgentSessionStoreTargetsSync).not.toHaveBeenCalled();
  });
});
