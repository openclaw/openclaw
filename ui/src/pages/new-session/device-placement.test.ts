// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  buildSessionPlacementBlockers,
  projectDevicePlacements,
  sessionPlacementDisabledReason,
  stackDisabledReasons,
} from "./device-placement.ts";
import type { DraftEnvironment } from "./discovery.ts";

const updateIssue = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

function node(overrides: Partial<DraftEnvironment>): DraftEnvironment {
  return {
    id: "node:runner",
    type: "node",
    label: "Build runner",
    status: "available",
    sessionHost: true,
    workerSlots: { total: 2, available: 1 },
    platform: "darwin",
    capabilities: ["camera.snap"],
    ...overrides,
  };
}

describe("device placement projection", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it.each([
    {
      name: "available host",
      environment: node({}),
      selectable: true,
      reason: undefined,
      facts: ["macOS", "Camera"],
    },
    {
      name: "saturated host",
      environment: node({ workerSlots: { total: 2, available: 0 } }),
      selectable: false,
      reason: "No worker slots are available. Wait for a slot or pick another device.",
      facts: [
        "No worker slots are available. Wait for a slot or pick another device.",
        "macOS",
        "Camera",
      ],
    },
    {
      name: "missing live capacity",
      environment: node({ workerSlots: undefined }),
      selectable: false,
      reason: "Worker capacity is unavailable. Restart the device session host and try again.",
      facts: [
        "Worker capacity is unavailable. Restart the device session host and try again.",
        "macOS",
        "Camera",
      ],
    },
    {
      name: "offline durable host",
      environment: node({ status: "unavailable", workerSlots: undefined }),
      selectable: false,
      reason: "Device unavailable. Reconnect it and try again.",
      facts: [
        "Never connected",
        "Device unavailable. Reconnect it and try again.",
        "macOS",
        "Camera",
      ],
    },
    {
      name: "connected non-host",
      environment: node({ sessionHost: false, workerSlots: undefined }),
      selectable: false,
      reason:
        "Session hosting is disabled. Run openclaw connect --service --session-host on the device.",
      facts: [
        "Session hosting is disabled. Run openclaw connect --service --session-host on the device.",
        "macOS",
        "Camera",
      ],
    },
    {
      name: "update required",
      environment: node({ issues: [updateIssue] }),
      selectable: false,
      reason:
        "Update required: run openclaw update, then reconnect. For a headless node, run openclaw node restart.",
      facts: [
        "Update required: run openclaw update, then reconnect. For a headless node, run openclaw node restart.",
        "macOS",
        "Camera",
      ],
    },
  ])("projects $name with one canonical eligibility decision", (testCase) => {
    expect(projectDevicePlacements([testCase.environment])).toMatchObject([
      {
        deviceId: "runner",
        label: "Build runner",
        selectable: testCase.selectable,
        facts: testCase.facts,
        ...(testCase.reason ? { disabledReason: testCase.reason } : {}),
      },
    ]);
  });

  it("ignores non-node environment rows", () => {
    expect(
      projectDevicePlacements([
        { id: "gateway", type: "local", status: "available" },
        { id: "worker:cloud", type: "worker", status: "available" },
      ]),
    ).toEqual([]);
  });

  it("adds short device ids only when labels collide", () => {
    expect(
      projectDevicePlacements([
        node({ id: "node:unique", label: "Unique runner" }),
        node({ id: "node:alpha-device", label: "Duplicate runner" }),
        node({ id: "node:beta-device", label: "Duplicate runner" }),
      ]).map(({ deviceId, subtitle }) => ({ deviceId, subtitle })),
    ).toEqual([
      { deviceId: "alpha-device", subtitle: "alpha-de" },
      { deviceId: "beta-device", subtitle: "beta-dev" },
      { deviceId: "unique", subtitle: undefined },
    ]);
  });

  it.each([
    {
      name: "remote execution remains available when every worker slot is occupied",
      requirement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      environment: {
        workerSlots: { total: 2, available: 0 },
        invocableCommands: ["codex.exec-server.stdio.v1"],
        requiredNodeCommand: {
          command: "codex.exec-server.stdio.v1",
          state: "invocable" as const,
        },
      },
      selectable: true,
    },
    {
      name: "worker turns remain unavailable when every worker slot is occupied",
      requirement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      environment: { workerSlots: { total: 2, available: 0 } },
      selectable: false,
      reason: "No worker slots are available. Wait for a slot or pick another device.",
    },
    {
      name: "declaring a command does not grant Gateway invocation authority",
      requirement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      environment: {
        capabilities: ["codex.exec-server.stdio.v1"],
        invocableCommands: [],
        requiredNodeCommand: {
          command: "codex.exec-server.stdio.v1",
          state: "unauthorized" as const,
        },
      },
      selectable: false,
      reason:
        "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.",
    },
    {
      name: "an undeclared command fails closed even when worker slots are free",
      requirement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      environment: {
        invocableCommands: ["camera.snap"],
        requiredNodeCommand: {
          command: "codex.exec-server.stdio.v1",
          state: "undeclared" as const,
        },
      },
      selectable: false,
      reason:
        "Make codex.exec-server.stdio.v1 available on this device, then reconnect, or pick another device.",
    },
    {
      name: "a pending-approval command reports awaiting pairing approval",
      requirement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      environment: {
        requiredNodeCommand: {
          command: "codex.exec-server.stdio.v1",
          state: "pending-approval" as const,
        },
      },
      selectable: false,
      reason:
        "Ask an administrator to approve the pending codex.exec-server.stdio.v1 request, or pick another device.",
    },
    {
      name: "missing command state fails closed",
      requirement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      environment: {},
      selectable: false,
      reason: "The selected runner isn't ready yet. Try again in a moment.",
    },
  ])("$name", ({ requirement, environment, selectable, reason }) => {
    const [device] = projectDevicePlacements([node(environment)], requirement);

    expect(device?.selectable).toBe(selectable);
    if (reason) {
      expect(device?.disabledReason).toBe(reason);
    }
  });

  it("stacks connected-host inventory disqualifiers instead of a single misleading reason", () => {
    const [device] = projectDevicePlacements(
      [
        node({
          sessionHost: false,
          workerSlots: { total: 1, available: 0 },
          capabilities: ["codex.exec-server.stdio.v1"],
          invocableCommands: [],
          requiredNodeCommand: {
            command: "codex.exec-server.stdio.v1",
            state: "undeclared",
          },
        }),
      ],
      {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
    );

    expect(device?.selectable).toBe(false);
    expect(device?.disabledReason).toMatch(/session hosting is disabled/i);
    expect(device?.disabledReason).toMatch(/codex\.exec-server\.stdio\.v1/i);
    expect(device?.disabledReason).toMatch(/available on this device/i);
  });

  it("hard-disables every host when session blockers include workspace symlinks and prepared auth", () => {
    const blockers = buildSessionPlacementBlockers({
      workspaceHasEscapingSymlinks: true,
      missingPreparedAuth: true,
    });
    const reason = sessionPlacementDisabledReason(blockers);
    expect(reason).toMatch(/absolute symlinks/i);
    expect(reason).toMatch(/prepared OpenAI auth/i);
    expect(reason).toMatch(/homeScope="agent"/i);

    const [device] = projectDevicePlacements([node({})], undefined, reason);
    expect(device?.selectable).toBe(false);
    expect(device?.disabledReason).toBe(reason);
    expect(device?.remediation).toBeUndefined();
  });

  it("does not offer selectable hosts when only a runtime session blocker applies", () => {
    const reason = sessionPlacementDisabledReason(
      buildSessionPlacementBlockers({
        runtimeUnsupportedReason: "This runtime does not support paired devices",
      }),
    );
    const devices = projectDevicePlacements(
      [
        node({ id: "node:macbook", label: "MacBook" }),
        node({ id: "node:pi", label: "Raspberry Pi" }),
      ],
      { requiredNodeCommands: [], consumesWorkerSlot: true },
      reason,
    );
    expect(devices.every((device) => device.selectable === false)).toBe(true);
    expect(devices.map((device) => device.disabledReason)).toEqual([reason, reason]);
  });

  it("hard-disables from environments.list disabledReason / sessionPlacement projection", () => {
    const listReason = sessionPlacementDisabledReason(
      buildSessionPlacementBlockers({
        workspaceHasEscapingSymlinks: true,
        missingPreparedAuth: true,
      }),
    );
    const [device] = projectDevicePlacements(
      [
        node({
          disabledReason: listReason,
        }),
      ],
      { requiredNodeCommands: [], consumesWorkerSlot: true },
    );
    expect(device?.selectable).toBe(false);
    expect(device?.disabledReason).toMatch(/absolute symlinks/i);
    expect(device?.disabledReason).toMatch(/prepared OpenAI auth/i);
  });

  it("stackDisabledReasons deduplicates identical sentences", () => {
    expect(stackDisabledReasons(["A.", "A.", "B."])).toBe("A. B.");
    expect(stackDisabledReasons([undefined, "  ", undefined])).toBeUndefined();
  });
});
