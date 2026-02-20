import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/workspace-dirs.js", () => ({
  listAgentWorkspaceDirs: vi.fn(() => ["/tmp/workspace"]),
}));

vi.mock("../agents/skills.js", () => ({
  loadWorkspaceSkillEntries: vi.fn(() => [
    {
      metadata: {
        os: ["darwin"],
        requires: { bins: ["foo"] },
      },
    },
  ]),
}));

vi.mock("./node-pairing.js", () => ({
  listNodePairing: vi.fn(async () => ({ paired: [] })),
  updatePairedNodeMetadata: vi.fn(async () => {}),
}));

vi.mock("../agents/skills/refresh.js", () => ({
  bumpSkillsSnapshotVersion: vi.fn(() => {}),
}));

import {
  __getRemoteProbeStateForTest,
  __resetRemoteProbeStateForTest,
  __setRemoteProbePolicyForTest,
  refreshRemoteNodeBins,
  removeRemoteNodeInfo,
  setSkillsRemoteRegistry,
} from "./skills-remote.js";

describe("skills-remote probe backoff", () => {
  beforeEach(() => {
    vi.useRealTimers();
    __resetRemoteProbeStateForTest();
  });

  it("suppresses repeated probes during the backoff window", async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: { message: "node not connected" } }));
    setSkillsRemoteRegistry({ invoke } as never);
    __setRemoteProbePolicyForTest({
      baseBackoffMs: 1_000,
      maxBackoffMs: 1_000,
      circuitOpenAfterFailures: 10,
      circuitOpenMs: 60_000,
    });

    await refreshRemoteNodeBins({
      nodeId: "node-a",
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });
    await refreshRemoteNodeBins({
      nodeId: "node-a",
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(__getRemoteProbeStateForTest("node-a")?.failures).toBe(1);
    removeRemoteNodeInfo("node-a");
  });

  it("opens a temporary circuit after repeated failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T12:00:00.000Z"));

    const invoke = vi.fn(async () => ({ ok: false, error: { message: "invoke timed out" } }));
    setSkillsRemoteRegistry({ invoke } as never);
    __setRemoteProbePolicyForTest({
      baseBackoffMs: 10,
      maxBackoffMs: 10,
      circuitOpenAfterFailures: 2,
      circuitOpenMs: 1_000,
    });

    await refreshRemoteNodeBins({
      nodeId: "node-b",
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });
    vi.setSystemTime(new Date("2026-02-20T12:00:00.020Z"));
    await refreshRemoteNodeBins({
      nodeId: "node-b",
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });
    await refreshRemoteNodeBins({
      nodeId: "node-b",
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });

    expect(invoke).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-02-20T12:00:01.200Z"));
    await refreshRemoteNodeBins({
      nodeId: "node-b",
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });

    expect(invoke).toHaveBeenCalledTimes(3);
    removeRemoteNodeInfo("node-b");
  });

  it("clears failure state after a successful probe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T12:00:00.000Z"));

    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { message: "node unavailable" } })
      .mockResolvedValueOnce({
        ok: true,
        payloadJSON: JSON.stringify({ bins: ["foo"] }),
      });
    setSkillsRemoteRegistry({ invoke } as never);
    __setRemoteProbePolicyForTest({
      baseBackoffMs: 10,
      maxBackoffMs: 10,
      circuitOpenAfterFailures: 5,
      circuitOpenMs: 1_000,
    });

    await refreshRemoteNodeBins({
      nodeId: "node-c",
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });
    expect(__getRemoteProbeStateForTest("node-c")?.failures).toBe(1);

    vi.setSystemTime(new Date("2026-02-20T12:00:00.020Z"));
    await refreshRemoteNodeBins({
      nodeId: "node-c",
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(__getRemoteProbeStateForTest("node-c")).toBeUndefined();
    removeRemoteNodeInfo("node-c");
  });
});
