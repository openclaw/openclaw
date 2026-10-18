import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { NodeRegistry } from "../../gateway/node-registry.js";
import { GatewayConnectionWork } from "../../gateway/server-connection-work.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import { closeSkillsWatchers } from "./refresh.js";
import { mergeRemoteNodeSkillEntries, replaceRemoteNodeSkills } from "./remote-skills.js";
import {
  createRemoteSkillWorkspace,
  recordRemoteMacWithSystemWhich,
  setTestSkillsRemoteRegistry,
  TEST_PAIRING_GENERATION,
  testRemoteSession,
} from "./remote.test-helpers.js";

vi.mock("../../infra/device-pairing-node-facts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/device-pairing-node-facts.js")>();
  return { ...actual, updatePairedNodeBins: vi.fn(async () => true) };
});

import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
  removeRemoteNodeInfoForConnection,
  refreshRemoteBinsForConnectedNodes,
  refreshRemoteNodeBins,
  setSkillsRemoteRegistry,
} from "./remote.js";

const recordMac = (
  nodeId: string,
  info: Omit<Parameters<typeof recordRemoteNodeInfo>[0], "nodeId" | "platform" | "commands"> & {
    commands?: string[];
  } = {},
) => recordRemoteNodeInfo({ nodeId, platform: "darwin", commands: ["system.run"], ...info });
const cleanups: (() => void)[] = [];
function newNode() {
  const nodeId = `node-${randomUUID()}`;
  cleanups.push(() => removeRemoteNodeInfo(nodeId));
  return nodeId;
}
function workspaceForBin(bin: string) {
  const fixture = createRemoteSkillWorkspace(bin);
  cleanups.push(() => fs.rmSync(fixture.workspaceDir, { recursive: true, force: true }));
  return fixture;
}
function remoteFixture() {
  const nodeId = newNode();
  const bin = `bin-${randomUUID()}`;
  return { nodeId, bin, ...workspaceForBin(bin) };
}
const probeTimeout = () => ({
  ok: false as const,
  error: { code: "TIMEOUT", message: "node invoke timed out" },
});
const probe = (
  nodeId: string,
  cfg: Parameters<typeof refreshRemoteNodeBins>[0]["cfg"],
  options: Omit<Parameters<typeof refreshRemoteNodeBins>[0], "nodeId" | "cfg"> = {},
) =>
  refreshRemoteNodeBins({
    nodeId,
    platform: "darwin",
    commands: ["system.run", "system.which"],
    cfg,
    ...options,
  });

describe("skills-remote", () => {
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    setSkillsRemoteRegistry(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves bins across reconnects only within one pairing generation", () => {
    const nodeId = newNode();
    const retiredBin = `bin-${randomUUID()}`;
    recordMac(nodeId, { connId: "conn-a", pairingGeneration: "generation-a" });
    recordRemoteNodeBins(nodeId, [retiredBin], "generation-a");
    recordMac(nodeId, { connId: "conn-a-reconnect", pairingGeneration: "generation-a" });
    expect(getRemoteSkillEligibility()?.hasBin(retiredBin)).toBe(true);

    recordMac(nodeId, { connId: "conn-b", pairingGeneration: "generation-b" });
    expect(getRemoteSkillEligibility()?.hasBin(retiredBin) ?? false).toBe(false);
  });

  it("removes remote projections only for the exact invalidated connection", () => {
    const nodeId = newNode();
    const bin = `bin-${randomUUID()}`;
    const skillName = `skill-${randomUUID()}`;
    recordMac(nodeId, { connId: "conn-current", displayName: "Remote Mac" });
    recordRemoteNodeBins(nodeId, [bin], TEST_PAIRING_GENERATION);
    replaceRemoteNodeSkills({
      nodeId,
      displayName: "Remote Mac",
      skills: [
        {
          name: skillName,
          description: "Remote test skill",
          content: `---\nname: ${skillName}\ndescription: Remote test skill\n---\n`,
        },
      ],
    });
    const listRemoteSkillNames = () =>
      mergeRemoteNodeSkillEntries([], { canExec: true }).map((entry) => entry.skill.name);

    expect(removeRemoteNodeInfoForConnection(nodeId, "conn-retired")).toBe(false);
    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
    expect(listRemoteSkillNames()).toContain(skillName);
    expect(removeRemoteNodeInfoForConnection(nodeId, "conn-current")).toBe(true);
    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
    expect(listRemoteSkillNames()).not.toContain(skillName);
  });

  it("ignores non-mac and non-system.run nodes for eligibility", () => {
    const linuxNodeId = `node-${randomUUID()}`;
    const noRunNodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: linuxNodeId,
        displayName: "Linux Box",
        platform: "linux",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(linuxNodeId, [bin], TEST_PAIRING_GENERATION);

      recordRemoteNodeInfo({
        nodeId: noRunNodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.which"],
      });
      recordRemoteNodeBins(noRunNodeId, [bin], TEST_PAIRING_GENERATION);

      expect(getRemoteSkillEligibility()).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(linuxNodeId);
      removeRemoteNodeInfo(noRunNodeId);
    }
  });

  it("aggregates bins and note labels across eligible mac nodes", () => {
    const nodeA = newNode();
    const nodeB = newNode();
    const binA = `bin-${randomUUID()}`;
    const binB = `bin-${randomUUID()}`;
    recordMac(nodeA, { displayName: "Mac Studio" });
    recordRemoteNodeBins(nodeA, [binA], TEST_PAIRING_GENERATION);

    recordRemoteNodeInfo({
      nodeId: nodeB,
      platform: "macOS",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeB, [binB], TEST_PAIRING_GENERATION);

    const eligibility = getRemoteSkillEligibility();
    expect(eligibility?.platforms).toEqual(["darwin"]);
    expect(eligibility?.hasBin(binA)).toBe(true);
    expect(eligibility?.hasAnyBin([`missing-${randomUUID()}`, binB])).toBe(true);
    expect(eligibility?.note).toContain("Mac Studio");
    expect(eligibility?.note).toContain(nodeB);
  });

  it("suppresses the exec host=node note when routing is not allowed", () => {
    const nodeId = newNode();
    const bin = `bin-${randomUUID()}`;
    recordMac(nodeId, { displayName: "Mac Studio" });
    recordRemoteNodeBins(nodeId, [bin], TEST_PAIRING_GENERATION);

    const eligibility = getRemoteSkillEligibility({ advertiseExecNode: false });

    expect(eligibility?.hasBin(bin)).toBe(true);
    expect(eligibility?.note).toBeUndefined();
  });

  it("does not expose bins for nodes that only have cached paired metadata", () => {
    const nodeId = newNode();
    const bin = `bin-${randomUUID()}`;
    recordRemoteNodeBins(nodeId, [bin], TEST_PAIRING_GENERATION);

    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
  });

  it.each([
    { command: "system.which", failure: "result" },
    { command: "system.run", failure: "throw" },
  ])(
    "clears stale bins after a probe failure ($command/$failure)",
    async ({ command, failure }) => {
      await closeSkillsWatchers(true);
      const { nodeId, bin, cfg, workspaceDir } = remoteFixture();
      const invokeCalls: string[] = [];
      setTestSkillsRemoteRegistry(nodeId, {
        get: () => testRemoteSession(nodeId, { commands: [command] }),
        invoke: async (params: { command: string }) => {
          invokeCalls.push(params.command);
          if (failure === "throw") {
            throw new Error("node invoke timed out");
          }
          return probeTimeout();
        },
      } as unknown as NodeRegistry);
      recordRemoteMacWithSystemWhich(nodeId);
      recordRemoteNodeBins(nodeId, [bin], TEST_PAIRING_GENERATION);
      const before = getSkillsSnapshotVersion(workspaceDir);

      await probe(nodeId, cfg, { timeoutMs: 10 });

      expect(invokeCalls).toEqual([command]);
      expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
    },
  );

  it("skips remote bin probes when the node connectivity preflight fails", async () => {
    await closeSkillsWatchers(true);
    const { nodeId, bin, cfg, workspaceDir } = remoteFixture();
    const invokeCalls: string[] = [];
    setTestSkillsRemoteRegistry(nodeId, {
      get: () => testRemoteSession(nodeId),
      checkConnectivity: async () => ({
        ok: false,
        error: { code: "TIMEOUT", message: "node connectivity check timed out" },
      }),
      invoke: async (params: { command: string }) => {
        invokeCalls.push(params.command);
        return { ok: true, payloadJSON: JSON.stringify({ bins: [bin] }) };
      },
    } as unknown as NodeRegistry);
    recordMac(nodeId, {
      pairingGeneration: TEST_PAIRING_GENERATION,
      displayName: "Remote Mac",
      commands: ["system.run", "system.which"],
    });
    recordRemoteNodeBins(nodeId, [bin], TEST_PAIRING_GENERATION);
    const before = getSkillsSnapshotVersion(workspaceDir);

    await probe(nodeId, cfg, { timeoutMs: 10 });

    expect(invokeCalls).toEqual([]);
    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
  });

  it("retries the bin probe when the node reconnects during preflight", async () => {
    await closeSkillsWatchers(true);
    const { nodeId, bin, cfg } = remoteFixture();
    let connId = "conn-old";
    const connectivityCalls: string[] = [];
    const invokeCalls: string[] = [];
    setTestSkillsRemoteRegistry(nodeId, {
      get: () => testRemoteSession(nodeId, { connId }),
      checkConnectivity: async () => {
        connectivityCalls.push(connId);
        if (connectivityCalls.length === 1) {
          connId = "conn-new";
          recordRemoteNodeInfo(testRemoteSession(nodeId, { connId, displayName: "Remote Mac" }));
          return {
            ok: false,
            error: { code: "TIMEOUT", message: "node connectivity check timed out" },
          };
        }
        return { ok: true };
      },
      invoke: async (params: { command: string }) => {
        invokeCalls.push(params.command);
        return { ok: true, payloadJSON: JSON.stringify({ bins: [bin] }) };
      },
    } as unknown as NodeRegistry);
    recordRemoteNodeInfo(testRemoteSession(nodeId, { connId, displayName: "Remote Mac" }));

    await probe(nodeId, cfg, { timeoutMs: 10 });

    expect(connectivityCalls).toEqual(["conn-old", "conn-new"]);
    expect(invokeCalls).toEqual(["system.which"]);
    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
  });

  it("coalesces overlapping bin probes for the same node", async () => {
    vi.useFakeTimers();
    const { nodeId, cfg } = remoteFixture();
    const releaseProbe = createDeferred();
    const probeStarted = createDeferred();
    const firstLifetime = new AbortController();
    const secondLifetime = new AbortController();
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    const completed = vi.fn();
    const refresh = (readinessSignal: AbortSignal) =>
      probe(nodeId, cfg, { timeoutMs: 10, readinessSignal }).then(completed);
    const invoke = vi.fn(async () => {
      probeStarted.resolve();
      await releaseProbe.promise;
      return probeTimeout();
    });
    try {
      setTestSkillsRemoteRegistry(nodeId, {
        get: () => testRemoteSession(nodeId),
        invoke,
      });
      recordMac(nodeId, {
        pairingGeneration: TEST_PAIRING_GENERATION,
        displayName: "Remote Mac",
        commands: ["system.run", "system.which"],
      });

      first = refresh(firstLifetime.signal);
      await probeStarted.promise;
      second = refresh(secondLifetime.signal);
      firstLifetime.abort();
      secondLifetime.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledOnce();
      releaseProbe.resolve();

      await Promise.all([first, second]);
      expect(invoke).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledTimes(2);
    } finally {
      releaseProbe.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("reuses a successful probe after reconnect and invalidates the skills snapshot", async () => {
    await closeSkillsWatchers(true);
    const { nodeId, bin, cfg, workspaceDir } = remoteFixture();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const invoke = vi.fn(async () => ({ ok: true, payload: { bins: [bin] } }));
    setTestSkillsRemoteRegistry(nodeId, {
      get: () => testRemoteSession(nodeId),
      invoke,
    } as unknown as NodeRegistry);
    recordRemoteMacWithSystemWhich(nodeId);
    await probe(nodeId, cfg);

    removeRemoteNodeInfo(nodeId);
    recordRemoteMacWithSystemWhich(nodeId);
    const beforeRestore = getSkillsSnapshotVersion(workspaceDir);
    nowSpy.mockReturnValue(1_000_000 + 60_000);
    await probe(nodeId, cfg);

    expect(invoke).toHaveBeenCalledOnce();
    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(beforeRestore);

    nowSpy.mockReturnValue(1_000_000 + 30 * 60 * 1000);
    await probe(nodeId, cfg);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("backs off failures but probes immediately when required bins change", async () => {
    const nodeId = newNode();
    const firstBin = `bin-${randomUUID()}`;
    const secondBin = `bin-${randomUUID()}`;
    const { cfg } = workspaceForBin(firstBin);
    const { cfg: changedCfg } = workspaceForBin(secondBin);
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const invoke = vi.fn(async () => probeTimeout());
    setTestSkillsRemoteRegistry(nodeId, {
      get: () => testRemoteSession(nodeId),
      invoke,
    } as unknown as NodeRegistry);
    recordRemoteMacWithSystemWhich(nodeId);
    const refresh = (config = cfg) => probe(nodeId, config);

    await refresh();
    await refresh();
    expect(invoke).toHaveBeenCalledOnce();

    await refresh(changedCfg);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each(["disconnect", "shutdown", "commands", "replacement"] as const)(
    "rechecks the live node after loading workspace skills (%s)",
    async (change) => {
      const { nodeId, bin, cfg } = remoteFixture();
      const lifetime = new AbortController();
      let session: ReturnType<NodeRegistry["get"]> = testRemoteSession(nodeId, {
        commands: ["system.run"],
      });
      const invoke = vi.fn(async () => ({ ok: true as const, payload: { bins: [bin] } }));
      let refresh: Promise<void> | undefined;
      try {
        setTestSkillsRemoteRegistry(nodeId, { get: () => session, invoke });
        recordRemoteNodeInfo(session);
        refresh = refreshRemoteNodeBins({ nodeId, cfg, readinessSignal: lifetime.signal });
        if (change === "disconnect") {
          session = undefined;
          removeRemoteNodeInfo(nodeId);
        } else if (change === "shutdown") {
          lifetime.abort();
        } else {
          session = {
            ...session,
            commands: change === "replacement" ? ["system.which"] : [],
            pairingGeneration: "generation-current",
          };
          recordRemoteNodeInfo(session);
        }
        await refresh;

        if (change === "replacement") {
          expect(invoke).toHaveBeenCalledOnce();
          expect(invoke).toHaveBeenCalledWith(
            expect.objectContaining({
              command: "system.which",
              expectedPairingGeneration: "generation-current",
            }),
          );
        } else {
          expect(invoke).not.toHaveBeenCalled();
          expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
        }
      } finally {
        lifetime.abort();
        await Promise.allSettled([refresh]);
      }
    },
  );

  it("retires a Linux connect-readiness delay when the Gateway lifetime closes", async () => {
    vi.useFakeTimers();
    const { nodeId, bin, cfg } = remoteFixture();
    const owner = new GatewayConnectionWork();
    const checkConnectivity = vi.fn(async () => ({ ok: true as const }));
    const invoke = vi.fn(async () => ({ ok: true as const, payload: { bins: [bin] } }));
    const params = {
      nodeId,
      platform: "linux",
      commands: ["camera.list"],
      cfg,
      readinessDelayMs: 5_000,
      readinessSignal: owner.signal,
    };
    let refresh: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const session = testRemoteSession(nodeId, { platform: "linux", commands: ["camera.list"] });
      setTestSkillsRemoteRegistry(nodeId, {
        get: () => session,
        checkConnectivity,
        invoke,
      });
      recordRemoteNodeInfo(session);
      let admitted = false;
      refresh = owner.track(() =>
        runWithGatewayIndependentRootWorkAdmission(
          async () => {
            admitted = true;
            await refreshRemoteNodeBins(params);
          },
          "ws:preauth",
          owner.signal,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted).toBe(true);
      expect(owner.hasPendingWork).toBe(true);

      let closed = false;
      closing = owner.drain().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(true);
      expect(checkConnectivity).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      await refreshRemoteNodeBins({
        ...params,
        readinessDelayMs: 0,
        readinessSignal: undefined,
      });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      owner.beginClose();
      await closeSkillsWatchers();
      await vi.runAllTimersAsync();
      await Promise.allSettled([refresh, closing]);
    }
  });

  it("coalesces replacement waiters after a failed probe", async () => {
    const { nodeId, bin, cfg } = remoteFixture();
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    let connId = "conn-old";
    const firstInvoke = createDeferred<Awaited<ReturnType<NodeRegistry["invoke"]>>>();
    const firstInvokeStarted = createDeferred();
    const invoke = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstInvokeStarted.resolve();
        return await firstInvoke.promise;
      })
      .mockResolvedValueOnce({ ok: true as const, payload: { bins: [bin] } });
    setTestSkillsRemoteRegistry(nodeId, {
      get: () => testRemoteSession(nodeId, { connId }),
      invoke,
    } as unknown as NodeRegistry);
    recordRemoteNodeInfo(testRemoteSession(nodeId, { connId }));
    const refresh = () => probe(nodeId, cfg);

    const failedRefresh = refresh();
    await firstInvokeStarted.promise;
    removeRemoteNodeInfo(nodeId);
    connId = "conn-new";
    recordRemoteNodeInfo(testRemoteSession(nodeId, { connId }));
    const reconnectRefresh = refresh();
    const overlappingReconnectRefresh = refresh();
    firstInvoke.resolve(probeTimeout());
    await Promise.all([failedRefresh, reconnectRefresh, overlappingReconnectRefresh]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
  });

  it.each(["success", "throw"])(
    "does not carry a retired generation probe into its replacement (%s)",
    async (completion) => {
      const nodeId = newNode();
      const retiredBin = `bin-${randomUUID()}`;
      const currentBin = `bin-${randomUUID()}`;
      const { cfg, workspaceDir } = workspaceForBin(currentBin);
      let session = testRemoteSession(nodeId, {
        connId: "conn-a",
        pairingGeneration: "generation-a",
      });
      const retiredProbe = createDeferred<Awaited<ReturnType<NodeRegistry["invoke"]>>>();
      const retiredProbeStarted = createDeferred();
      const invoke = vi
        .fn()
        .mockImplementationOnce(async () => {
          retiredProbeStarted.resolve();
          return await retiredProbe.promise;
        })
        .mockResolvedValueOnce({ ok: true as const, payload: { bins: [currentBin] } });
      setTestSkillsRemoteRegistry(nodeId, {
        get: () => session,
        invoke,
      } as unknown as NodeRegistry);
      recordRemoteNodeInfo(session);
      const firstRefresh = probe(nodeId, cfg);
      await retiredProbeStarted.promise;

      session = { ...session, connId: "conn-b", pairingGeneration: "generation-b" };
      recordRemoteNodeInfo(session);
      recordRemoteNodeBins(nodeId, [currentBin], "generation-b");
      const replacementRefresh = probe(nodeId, cfg);
      const beforeCompletion = getSkillsSnapshotVersion(workspaceDir);
      if (completion === "throw") {
        retiredProbe.reject(new Error("retired probe failed"));
      } else {
        retiredProbe.resolve({
          ok: completion === "success",
          payload: { bins: [retiredBin] },
          error: { message: "retired probe failed" },
        });
      }
      await Promise.all([firstRefresh, replacementRefresh]);

      expect(invoke).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ expectedPairingGeneration: "generation-a" }),
      );
      expect(invoke).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ expectedPairingGeneration: "generation-b" }),
      );
      expect(getRemoteSkillEligibility()?.hasBin(retiredBin) ?? false).toBe(false);
      expect(getRemoteSkillEligibility()?.hasBin(currentBin)).toBe(true);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(beforeCompletion);
    },
  );

  it("uses the approved live command surface after the connect readiness delay", async () => {
    vi.useFakeTimers();
    const { nodeId, bin, cfg } = remoteFixture();
    let commands: string[] = [];
    let pairingGeneration = "generation-before-approval";
    const session = () =>
      testRemoteSession(nodeId, { connId: "conn-current", pairingGeneration, commands });
    const invoke = vi.fn(async () => ({ ok: true as const, payload: { bins: [bin] } }));
    setTestSkillsRemoteRegistry(nodeId, {
      get: session,
      checkConnectivity: async () => ({ ok: true }),
      invoke,
    } as unknown as NodeRegistry);
    recordRemoteNodeInfo(session());

    const connectRefresh = probe(nodeId, cfg, {
      commands: [],
      readinessDelayMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(invoke).not.toHaveBeenCalled();
    commands = ["system.run", "system.which"];
    pairingGeneration = TEST_PAIRING_GENERATION;
    recordRemoteNodeInfo(session());
    const approvalRefresh = probe(nodeId, cfg, { commands });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([connectRefresh, approvalRefresh]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId,
        command: "system.which",
        expectedPairingGeneration: TEST_PAIRING_GENERATION,
      }),
    );
  });

  it("records bins from system.which object-map responses", async () => {
    await closeSkillsWatchers(true);
    const { nodeId, bin, cfg, workspaceDir } = remoteFixture();
    const invokeCalls: string[] = [];
    setTestSkillsRemoteRegistry(nodeId, {
      get: () => testRemoteSession(nodeId),
      invoke: async (params: { command: string }) => {
        invokeCalls.push(params.command);
        return {
          ok: true,
          payload: { bins: { [bin]: `/opt/homebrew/bin/${bin}`, missing: "" } },
          payloadJSON: JSON.stringify({ bins: { [bin]: `/opt/homebrew/bin/${bin}` } }),
        };
      },
    } as unknown as NodeRegistry);
    recordRemoteMacWithSystemWhich(nodeId);
    const before = getSkillsSnapshotVersion(workspaceDir);

    await probe(nodeId, cfg, { timeoutMs: 10 });

    expect(invokeCalls).toEqual(["system.which"]);
    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
    expect(getRemoteSkillEligibility()?.hasBin("missing")).toBe(false);
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
  });

  it("continues the connected-node refresh after one node fails", async () => {
    await closeSkillsWatchers(true);
    const nodeA = newNode();
    const nodeB = newNode();
    const bin = `bin-${randomUUID()}`;
    const { cfg } = workspaceForBin(bin);
    const invokeCalls: string[] = [];
    setTestSkillsRemoteRegistry([nodeA, nodeB], {
      get: (nodeId: string) => testRemoteSession(nodeId),
      checkConnectivity: (nodeId: string) => {
        if (nodeId === nodeA) {
          throw new Error("simulated connectivity failure");
        }
        return { ok: true };
      },
      invoke: async (params: { command: string }) => {
        invokeCalls.push(params.command);
        return { ok: true, payloadJSON: JSON.stringify({ bins: [bin] }) };
      },
    } as unknown as NodeRegistry);
    recordRemoteMacWithSystemWhich(nodeA);
    recordRemoteMacWithSystemWhich(nodeB);
    recordRemoteNodeBins(nodeA, ["stale-bin"], TEST_PAIRING_GENERATION);

    await expect(refreshRemoteBinsForConnectedNodes(cfg)).resolves.toBeUndefined();

    expect(invokeCalls).toEqual(["system.which"]);
    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
    expect(getRemoteSkillEligibility()?.hasBin("stale-bin")).toBe(false);
  });

  it("refreshes bins only for generation-current connected sessions", async () => {
    await closeSkillsWatchers(true);
    const staleNodeId = newNode();
    const currentNodeId = newNode();
    const bin = `bin-${randomUUID()}`;
    const { cfg } = workspaceForBin(bin);
    const staleSession = testRemoteSession(staleNodeId, { connId: "conn-stale" });
    const currentSession = testRemoteSession(currentNodeId, { connId: "conn-current" });
    const invoke = vi.fn(async () => probeTimeout());
    const listCurrentConnected = vi.fn(async () => [currentSession]);
    setSkillsRemoteRegistry({
      listConnected: () => [staleSession, currentSession],
      listCurrentConnected,
      listCurrentConnectedSync: () => [currentSession],
      get: (nodeId: string) => (nodeId === currentNodeId ? currentSession : staleSession),
      invoke,
    } as unknown as NodeRegistry);
    recordRemoteNodeInfo(staleSession);
    recordRemoteNodeInfo(currentSession);

    await refreshRemoteBinsForConnectedNodes(cfg);

    expect(listCurrentConnected).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ nodeId: currentNodeId }));
  });
});
