import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SubagentRunRecord } from "../subagent-registry.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "../subagent-registry.js";

const callGatewayMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: OpenClawConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

vi.mock("../pi-embedded.js", () => ({
  abortEmbeddedPiRun: (sessionId: string) => abortEmbeddedPiRunMock(sessionId),
}));

import { createSessionsKillTool } from "./sessions-kill-tool.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let tempStateDir: string | null = null;

function addRun(params: { runId: string; childSessionKey: string; requesterSessionKey: string }) {
  addSubagentRunForTests({
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterDisplayKey: "main",
    task: "task",
    cleanup: "keep",
    createdAt: Date.now(),
    childKeys: new Set<string>(),
  } as SubagentRunRecord);
}

beforeEach(async () => {
  configOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  };
  callGatewayMock.mockReset();
  abortEmbeddedPiRunMock.mockReset();
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-kill-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  resetSubagentRegistryForTests({ persist: false });
});

afterEach(async () => {
  resetSubagentRegistryForTests({ persist: false });
  if (tempStateDir) {
    await fs.rm(tempStateDir, { recursive: true, force: true });
    tempStateDir = null;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("sessions_kill tool", () => {
  it("kills subtree leaf-first with embedded-first abort strategy", async () => {
    const parent = "agent:main:subagent:parent";
    const child = "agent:main:subagent:child";
    const leaf = "agent:main:subagent:leaf";

    addRun({ runId: "run-parent", childSessionKey: parent, requesterSessionKey: "main" });
    addRun({ runId: "run-child", childSessionKey: child, requesterSessionKey: parent });
    addRun({ runId: "run-leaf", childSessionKey: leaf, requesterSessionKey: child });

    abortEmbeddedPiRunMock.mockImplementation((sessionId: string) => sessionId === child);
    callGatewayMock.mockResolvedValue({ ok: true });

    const tool = createSessionsKillTool({ agentSessionKey: "main" });
    const result = await tool.execute("call-kill", { sessionKey: parent });
    const details = result.details as {
      status: string;
      aborted: number;
      results: Array<{ sessionKey: string; runId?: string; status: string; via: string }>;
    };

    expect(details.status).toBe("ok");
    expect(details.aborted).toBe(3);
    expect(details.results.map((entry) => entry.sessionKey)).toEqual([leaf, child, parent]);
    expect(details.results[0]).toMatchObject({
      sessionKey: leaf,
      runId: "run-leaf",
      via: "gateway",
    });
    expect(details.results[1]).toMatchObject({
      sessionKey: child,
      runId: "run-child",
      via: "embedded",
    });
    expect(details.results[2]).toMatchObject({
      sessionKey: parent,
      runId: "run-parent",
      via: "gateway",
    });

    const abortCalls = callGatewayMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "agent.abort",
    );
    expect(abortCalls).toHaveLength(2);
    expect(abortCalls[0]?.[0]).toMatchObject({
      method: "agent.abort",
      params: { runId: "run-leaf" },
    });
    expect(abortCalls[1]?.[0]).toMatchObject({
      method: "agent.abort",
      params: { runId: "run-parent" },
    });
  });

  it("enforces lineage guard for subagent callers", async () => {
    const caller = "agent:main:subagent:caller";
    const sibling = "agent:main:subagent:sibling";

    addRun({ runId: "run-caller", childSessionKey: caller, requesterSessionKey: "main" });
    addRun({ runId: "run-sibling", childSessionKey: sibling, requesterSessionKey: "main" });

    const tool = createSessionsKillTool({ agentSessionKey: caller });
    const result = await tool.execute("call-forbidden", {
      sessionKey: sibling,
      cascade: false,
    });

    expect(result.details).toMatchObject({ status: "forbidden" });
    expect(abortEmbeddedPiRunMock).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns not_found when no run record exists", async () => {
    const missing = "agent:main:subagent:missing";

    const tool = createSessionsKillTool({ agentSessionKey: "main" });
    const result = await tool.execute("call-missing", {
      sessionKey: missing,
      cascade: false,
    });
    const details = result.details as {
      status: string;
      notFound: number;
      results: Array<{ sessionKey: string; status: string }>;
    };

    expect(details.status).toBe("not_found");
    expect(details.notFound).toBe(1);
    expect(details.results).toEqual([
      {
        sessionKey: missing,
        status: "not_found",
        via: "none",
      },
    ]);
  });
});
