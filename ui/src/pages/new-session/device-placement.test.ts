// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  projectDevicePlacements,
  resolveAutomaticDevicePlacementDisabledReason,
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
      name: "ignores unknown capabilities that match object prototype properties",
      environment: node({ capabilities: ["constructor", "__proto__", "camera.snap"] }),
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

  it("shows the host's actionable failure before generic offline or disabled-host hints", () => {
    const message = "state directory /srv/node is group-writable; run chmod go-w /srv/node";
    const environments = [
      node({
        status: "available",
        sessionHost: false,
        workerSlots: undefined,
        issues: [{ code: "worker-host-unavailable", message }],
      }),
    ];
    const devices = projectDevicePlacements(environments);

    expect(devices[0]).toMatchObject({
      selectable: false,
      disabledReason: message,
      hideDetails: false,
      remediation: undefined,
      facts: [message, "macOS", "Camera"],
    });
    expect(resolveAutomaticDevicePlacementDisabledReason(environments, devices)).toBe(message);
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

  it.each(["pending-approval", "undeclared", "unauthorized", "invocable"] as const)(
    "uses Gateway command remediation without changing %s eligibility",
    (state) => {
      const message = "Enable the codex plugin on this node with openclaw plugins enable codex.";
      const [device] = projectDevicePlacements(
        [
          node({
            requiredNodeCommand: { command: "codex.exec-server.stdio.v1", state, message },
          }),
        ],
        { requiredNodeCommands: ["codex.exec-server.stdio.v1"], consumesWorkerSlot: false },
      );

      expect(device?.selectable).toBe(state === "invocable");
      expect(device?.disabledReason).toBe(state === "invocable" ? undefined : message);
    },
  );
});
