import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  refreshRemoteNodeBins,
  removeRemoteNodeInfo,
  setSkillsRemoteRegistry,
} from "./skills-remote.js";

describe("skills-remote", () => {
  it("removes disconnected nodes from remote skill eligibility", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeId, [bin]);

    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);

    removeRemoteNodeInfo(nodeId);

    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
  });

  it("backs off after repeated probe failures", async () => {
    const nodeId = `node-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Failing Mac",
      platform: "darwin",
      commands: ["system.run"],
    });

    const mockRegistry = {
      invoke: vi.fn().mockResolvedValue({ ok: false, error: { message: "invoke timed out" } }),
      listConnected: vi.fn().mockReturnValue([]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSkillsRemoteRegistry(mockRegistry as any);

    const cfg = { agents: { list: [] } } as unknown as OpenClawConfig;

    // First call: should invoke (and fail).
    await refreshRemoteNodeBins({
      nodeId,
      platform: "darwin",
      commands: ["system.run"],
      cfg,
    });
    expect(mockRegistry.invoke).toHaveBeenCalledTimes(1);

    // Second call immediately after: should be skipped due to backoff.
    await refreshRemoteNodeBins({
      nodeId,
      platform: "darwin",
      commands: ["system.run"],
      cfg,
    });
    expect(mockRegistry.invoke).toHaveBeenCalledTimes(1); // still 1 — skipped

    // Clean up.
    removeRemoteNodeInfo(nodeId);
    setSkillsRemoteRegistry(null);
  });

  it("supports idempotent remote node removal", () => {
    const nodeId = `node-${randomUUID()}`;
    expect(() => {
      removeRemoteNodeInfo(nodeId);
      removeRemoteNodeInfo(nodeId);
    }).not.toThrow();
  });
});
