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
  beforeEach(() => i18n.setLocale("en"));

  it.each([
    [
      "ignores prototype capabilities",
      { capabilities: ["constructor", "__proto__", "camera.snap"] },
      undefined,
    ],
    [
      "saturated host",
      { workerSlots: { total: 2, available: 0 } },
      "No worker slots are available. Wait for a slot or pick another device.",
    ],
    [
      "missing live capacity",
      { workerSlots: undefined },
      "Worker capacity is unavailable. Restart the device session host and try again.",
    ],
    [
      "offline durable host",
      { status: "unavailable", workerSlots: undefined },
      "Device unavailable. Reconnect it and try again.",
    ],
    [
      "connected non-host",
      { sessionHost: false, workerSlots: undefined },
      "Session hosting is disabled. On the paired device, run openclaw config set nodeHost.workerRuns.enabled true, then openclaw node install --force.",
    ],
    [
      "update required",
      { issues: [updateIssue] },
      "Update required: run openclaw update, then reconnect. For a headless node, run openclaw node restart.",
    ],
  ] satisfies [string, Partial<DraftEnvironment>, string | undefined][])(
    "projects %s with one canonical eligibility decision",
    (_: string, overrides: Partial<DraftEnvironment>, reason: string | undefined) => {
      expect(projectDevicePlacements([node(overrides)])).toMatchObject([
        {
          deviceId: "runner",
          label: "Build runner",
          selectable: reason === undefined,
          facts: [
            ...(overrides.status === "unavailable" ? ["Never connected"] : []),
            ...(reason ? [reason] : []),
            "macOS",
            "Camera",
          ],
          ...(reason ? { disabledReason: reason } : {}),
        },
      ]);
    },
  );

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

  const command = "codex.exec-server.stdio.v1";
  const requirement = { requiredNodeCommands: [command], consumesWorkerSlot: false };
  it.each([
    [
      "an undeclared command fails closed even when worker slots are free",
      { invocableCommands: ["camera.snap"], requiredNodeCommand: { command, state: "undeclared" } },
      "Make codex.exec-server.stdio.v1 available on this device, then reconnect, or pick another device.",
    ],
    [
      "a pending-approval command reports awaiting pairing approval",
      { requiredNodeCommand: { command, state: "pending-approval" } },
      "Ask an administrator to approve the pending codex.exec-server.stdio.v1 request, or pick another device.",
    ],
    [
      "missing command state fails closed",
      {},
      "The selected runner isn't ready yet. Try again in a moment.",
    ],
  ] satisfies [string, Partial<DraftEnvironment>, string][])("%s", (_, environment, reason) => {
    const [device] = projectDevicePlacements([node(environment)], requirement);
    expect(device).toMatchObject({ selectable: false, disabledReason: reason });
  });

  it.each(["undeclared", "invocable"] as const)(
    "uses Gateway command remediation without changing %s eligibility",
    (state) => {
      const message = "Enable the codex plugin on this node with openclaw plugins enable codex.";
      const [device] = projectDevicePlacements(
        [node({ requiredNodeCommand: { command, state, message } })],
        requirement,
      );

      expect(device?.selectable).toBe(state === "invocable");
      expect(device?.disabledReason).toBe(state === "invocable" ? undefined : message);
    },
  );
});
