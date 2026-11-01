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
function remoteFixture(info: Partial<NonNullable<ReturnType<NodeRegistry["get"]>>> = {}) {
  const nodeId = newNode();
  const bin = `bin-${randomUUID()}`;
  const workspace = workspaceForBin(bin);
  const initialSession = testRemoteSession(nodeId, {
    displayName: "Remote Mac",
    ...info,
  });
  let session: ReturnType<NodeRegistry["get"]> = initialSession;
  const invoke = vi.fn<NodeRegistry["invoke"]>(async () => successfulProbe(bin));
  const registry = (overrides: Partial<NodeRegistry> = {}) =>
    setTestSkillsRemoteRegistry(nodeId, { get: () => session, invoke, ...overrides });
  const connect = (overrides: typeof info = {}) => {
    session = { ...(session ?? initialSession), ...overrides };
    recordRemoteNodeInfo(session);
  };
  registry();
  connect();
  return {
    nodeId,
    bin,
    ...workspace,
    invoke,
    registry,
    connect,
    disconnect: () => {
      session = undefined;
      removeRemoteNodeInfo(nodeId);
    },
    refresh: (options: Parameters<typeof probe>[2] = {}) => probe(nodeId, workspace.cfg, options),
  };
}
const probeTimeout = () => ({
  ok: false as const,
  error: { code: "TIMEOUT", message: "node invoke timed out" },
});
const successfulProbe = (bin: string) => ({ ok: true as const, payload: { bins: [bin] } });
function deferredProbe(bin: string, invoke = vi.fn<NodeRegistry["invoke"]>()) {
  const started = createDeferred();
  const result = createDeferred<Awaited<ReturnType<NodeRegistry["invoke"]>>>();
  invoke
    .mockReset()
    .mockImplementationOnce(async () => {
      started.resolve();
      return await result.promise;
    })
    .mockResolvedValueOnce(successfulProbe(bin));
  return { started, result, invoke };
}
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

  it.each([
    { platform: "linux", commands: ["system.run"], connected: true },
    { platform: "darwin", commands: ["system.which"], connected: true },
    { platform: "darwin", commands: ["system.run"], connected: false },
  ])("excludes ineligible or disconnected nodes ($platform/$commands/$connected)", (info) => {
    const nodeId = newNode();
    const bin = `bin-${randomUUID()}`;
    if (info.connected) {
      recordRemoteNodeInfo({ nodeId, platform: info.platform, commands: info.commands });
    }
    recordRemoteNodeBins(nodeId, [bin], TEST_PAIRING_GENERATION);
    expect(getRemoteSkillEligibility()).toBeUndefined();
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
    const hiddenNote = getRemoteSkillEligibility({ advertiseExecNode: false });
    expect(hiddenNote?.hasBin(binA)).toBe(true);
    expect(hiddenNote?.note).toBeUndefined();
  });

  it.each([
    { command: "system.which", failure: "result" },
    { command: "system.run", failure: "throw" },
    { command: "system.which", failure: "preflight" },
  ])(
    "clears stale bins after a probe failure ($command/$failure)",
    async ({ command, failure }) => {
      await closeSkillsWatchers(true);
      const { nodeId, bin, workspaceDir, invoke, registry, refresh } = remoteFixture();
      invoke.mockImplementation(async () => {
        if (failure === "throw") {
          throw new Error("node invoke timed out");
        }
        return probeTimeout();
      });
      registry({
        get: () => testRemoteSession(nodeId, { commands: [command] }),
        checkConnectivity: failure === "preflight" ? async () => probeTimeout() : undefined,
      });
      recordRemoteNodeBins(nodeId, [bin], TEST_PAIRING_GENERATION);
      const before = getSkillsSnapshotVersion(workspaceDir);

      await refresh();

      expect(invoke.mock.calls.map(([params]) => params.command)).toEqual(
        failure === "preflight" ? [] : [command],
      );
      expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
    },
  );

  it("retries the bin probe when the node reconnects during preflight", async () => {
    await closeSkillsWatchers(true);
    const { bin, invoke, registry, refresh, connect } = remoteFixture({ connId: "conn-old" });
    let connId = "conn-old";
    const connectivityCalls: string[] = [];
    invoke.mockImplementation(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({ bins: [bin] }),
    }));
    registry({
      checkConnectivity: async () => {
        connectivityCalls.push(connId);
        if (connectivityCalls.length === 1) {
          connId = "conn-new";
          connect({ connId });
          return {
            ok: false,
            error: { code: "TIMEOUT", message: "node connectivity check timed out" },
          };
        }
        return { ok: true };
      },
    });
    await refresh();

    expect(connectivityCalls).toEqual(["conn-old", "conn-new"]);
    expect(invoke.mock.calls.map(([params]) => params.command)).toEqual(["system.which"]);
    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
  });

  it("coalesces overlapping bin probes for the same node", async () => {
    vi.useFakeTimers();
    const { invoke, refresh: probeNode } = remoteFixture();
    const releaseProbe = createDeferred();
    const probeStarted = createDeferred();
    const firstLifetime = new AbortController();
    const secondLifetime = new AbortController();
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    const completed = vi.fn();
    const refresh = (readinessSignal: AbortSignal) =>
      probeNode({ readinessSignal }).then(completed);
    invoke.mockImplementation(async () => {
      probeStarted.resolve();
      await releaseProbe.promise;
      return probeTimeout();
    });
    try {
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
    const { bin, workspaceDir, invoke, refresh, disconnect, connect } = remoteFixture();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await refresh();

    disconnect();
    connect();
    const beforeRestore = getSkillsSnapshotVersion(workspaceDir);
    nowSpy.mockReturnValue(1_000_000 + 60_000);
    await refresh();

    expect(invoke).toHaveBeenCalledOnce();
    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(beforeRestore);

    nowSpy.mockReturnValue(1_000_000 + 30 * 60 * 1000);
    await refresh();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("backs off failures but probes immediately when required bins change", async () => {
    const { nodeId, cfg, invoke } = remoteFixture();
    const { cfg: changedCfg } = workspaceForBin(`bin-${randomUUID()}`);
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    invoke.mockImplementation(async () => probeTimeout());
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
      const remote = remoteFixture({ commands: ["system.run"] });
      const lifetime = new AbortController();
      let refresh: Promise<void> | undefined;
      try {
        refresh = refreshRemoteNodeBins({
          nodeId: remote.nodeId,
          cfg: remote.cfg,
          readinessSignal: lifetime.signal,
        });
        if (change === "disconnect") {
          remote.disconnect();
        } else if (change === "shutdown") {
          lifetime.abort();
        } else {
          remote.connect({
            commands: change === "replacement" ? ["system.which"] : [],
            pairingGeneration: "generation-current",
          });
        }
        await refresh;

        if (change === "replacement") {
          expect(remote.invoke).toHaveBeenCalledOnce();
          expect(remote.invoke).toHaveBeenCalledWith(
            expect.objectContaining({
              command: "system.which",
              expectedPairingGeneration: "generation-current",
            }),
          );
        } else {
          expect(remote.invoke).not.toHaveBeenCalled();
          expect(getRemoteSkillEligibility()?.hasBin(remote.bin) ?? false).toBe(false);
        }
      } finally {
        lifetime.abort();
        await Promise.allSettled([refresh]);
      }
    },
  );

  it("retires a Linux connect-readiness delay when the Gateway lifetime closes", async () => {
    vi.useFakeTimers();
    const { nodeId, cfg, invoke, registry } = remoteFixture({
      platform: "linux",
      commands: ["camera.list"],
    });
    const owner = new GatewayConnectionWork();
    const checkConnectivity = vi.fn(async () => ({ ok: true as const }));
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
      registry({ checkConnectivity });
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
    const { bin, invoke, refresh, connect, disconnect } = remoteFixture({ connId: "conn-old" });
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const { result: firstInvoke, started: firstInvokeStarted } = deferredProbe(bin, invoke);

    const failedRefresh = refresh();
    await firstInvokeStarted.promise;
    disconnect();
    connect({ connId: "conn-new" });
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
      const retiredBin = `bin-${randomUUID()}`;
      const remote = remoteFixture({
        connId: "conn-a",
        pairingGeneration: "generation-a",
      });
      const { result: retiredProbe, started: retiredProbeStarted } = deferredProbe(
        remote.bin,
        remote.invoke,
      );
      const firstRefresh = remote.refresh();
      await retiredProbeStarted.promise;

      remote.connect({ connId: "conn-b", pairingGeneration: "generation-b" });
      recordRemoteNodeBins(remote.nodeId, [remote.bin], "generation-b");
      const replacementRefresh = remote.refresh();
      const beforeCompletion = getSkillsSnapshotVersion(remote.workspaceDir);
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

      expect(remote.invoke.mock.calls.map(([call]) => call.expectedPairingGeneration)).toEqual([
        "generation-a",
        "generation-b",
      ]);
      expect(getRemoteSkillEligibility()?.hasBin(retiredBin) ?? false).toBe(false);
      expect(getRemoteSkillEligibility()?.hasBin(remote.bin)).toBe(true);
      expect(getSkillsSnapshotVersion(remote.workspaceDir)).toBe(beforeCompletion);
    },
  );

  it("uses the approved live command surface after the connect readiness delay", async () => {
    vi.useFakeTimers();
    const { nodeId, invoke, registry, refresh, connect } = remoteFixture({
      connId: "conn-current",
      pairingGeneration: "generation-before-approval",
      commands: [],
    });
    registry({ checkConnectivity: async () => ({ ok: true }) });

    const connectRefresh = refresh({
      commands: [],
      readinessDelayMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(invoke).not.toHaveBeenCalled();
    const commands = ["system.run", "system.which"];
    connect({ commands, pairingGeneration: TEST_PAIRING_GENERATION });
    const approvalRefresh = refresh({ commands });

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
    const { bin, workspaceDir, invoke, refresh } = remoteFixture();
    invoke.mockImplementation(async () => ({
      ok: true,
      payload: { bins: { [bin]: `/opt/homebrew/bin/${bin}`, missing: "" } },
      payloadJSON: JSON.stringify({ bins: { [bin]: `/opt/homebrew/bin/${bin}` } }),
    }));
    const before = getSkillsSnapshotVersion(workspaceDir);

    await refresh();

    expect(invoke.mock.calls.map(([params]) => params.command)).toEqual(["system.which"]);
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
