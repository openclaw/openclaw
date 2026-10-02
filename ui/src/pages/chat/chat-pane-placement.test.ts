/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import {
  activePlacementSession,
  offlineDeviceSession,
  createTestChatPane,
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;

beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});

afterEach(async () => {
  try {
    await dialogs.cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});

function repositoryRecoveryFixture(placementState: "local" | undefined, fails = false) {
  const request = dialogs.mockRequest(async (method: string) => {
    if (method === "environments.list") {
      return {
        profiles: [{ id: "aws", providerId: "crabbox" }],
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Writer runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 1, available: 1 },
          },
        ],
      };
    }
    if (method === "sessions.dispatch" && fails) {
      throw new Error("Worker could not start");
    }
    return { ok: true };
  });
  const reconcileMutation = vi.fn<SessionCapability["reconcileMutation"]>(async () => ({
    status: "refreshed",
  }));
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture({ reconcileMutation }),
  });
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
    ["sessions.dispatch"],
    ["operator.read", "operator.write"],
  );
  const session: GatewaySessionRow = {
    key: "agent:main:repository",
    sessionId: "repository-session-1",
    label: "Repository recovery",
    kind: "direct",
    updatedAt: 0,
    repositoryWorkspaceId: "repository-workspace-1",
    ...(placementState
      ? {
          placement: {
            state: placementState,
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 1,
            stateChangedAtMs: 1,
          },
        }
      : {}),
    agentRuntime: {
      id: "openclaw",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
      devicePlacementSupported: true,
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      source: "model",
    },
  };
  state.sessionKey = session.key;
  state.currentSessionId = session.sessionId;
  state.sessionsResult = { ...createSessionsListResult(), sessions: [session] };
  return { pane, state, session, request, reconcileMutation };
}

async function selectRepositoryWorker() {
  await dialogs.waitFor(() => {
    expect(document.body.querySelector('[data-value="device:runner"]')).not.toBeNull();
  });
  expect(document.body.querySelector('[data-value="gateway"]')).toBeNull();
  document.body.querySelector<HTMLButtonElement>('[data-value="device:runner"]')?.click();
}

function answerWorkerPicker(label: "Continue on worker" | "Cancel") {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

describe("chat pane placement", () => {
  it.each([
    { placement: "local", outcome: "success" },
    { placement: undefined, outcome: "success" },
    { placement: "local", outcome: "cancel" },
    { placement: "local", outcome: "failure" },
    { placement: "local", outcome: "refresh failure" },
  ] as const)(
    "recovers a repository session with $placement placement: $outcome",
    async ({ placement, outcome }) => {
      const { pane, state, session, request, reconcileMutation } = repositoryRecoveryFixture(
        placement,
        outcome === "failure",
      );
      if (outcome === "refresh failure") {
        reconcileMutation.mockResolvedValueOnce({
          status: "failed",
          error: "Worker session refresh unavailable",
        });
      }
      const dispatching = dialogs.track(pane.changeHeaderPlacement(session, "recover"));
      await selectRepositoryWorker();
      answerWorkerPicker(outcome === "cancel" ? "Cancel" : "Continue on worker");
      await dispatching;

      expect(request).toHaveBeenCalledWith("environments.list", { runtimeId: "openclaw" });
      if (outcome === "cancel") {
        expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
        expect(reconcileMutation).not.toHaveBeenCalled();
      } else {
        expect(request).toHaveBeenCalledWith("sessions.dispatch", {
          key: session.key,
          agentId: "main",
          deviceId: "runner",
        });
        expect(reconcileMutation).toHaveBeenCalledWith("main");
      }
      expect(state.lastError).toBe(
        outcome === "failure"
          ? "Worker could not start"
          : outcome === "refresh failure"
            ? "Worker session refresh unavailable"
            : null,
      );
      expect(pane.headerPlacementRestartingKey).toBeNull();
    },
  );

  it("does not dispatch a replacement session after the worker picker opens", async () => {
    const { pane, state, session, request } = repositoryRecoveryFixture("local");
    const dispatching = dialogs.track(pane.changeHeaderPlacement(session, "recover"));
    await selectRepositoryWorker();
    const replacement = { ...session, sessionId: "repository-session-2" };
    state.currentSessionId = replacement.sessionId;
    state.sessionsResult = { ...createSessionsListResult(), sessions: [replacement] };
    answerWorkerPicker("Continue on worker");
    await dispatching;

    expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    expect(state.lastError).toBe("This Gateway does not support this session action.");
  });

  it("does not open worker dispatch for an archived repository session", async () => {
    const { pane, session, request } = repositoryRecoveryFixture("local");
    await pane.changeHeaderPlacement({ ...session, archived: true }, "recover");

    expect(request).not.toHaveBeenCalled();
    expect(document.body.querySelector("dialog[open]")).toBeNull();
  });

  it("shows authoritative device targets to writers and moves to the selected device", async () => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [{ id: "aws", providerId: "crabbox" }],
          environments: [
            {
              id: "node:runner",
              type: "node",
              label: "Writer runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
            {
              id: "node:saturated",
              type: "node",
              label: "Busy runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 0 },
            },
            {
              id: "node:offline",
              type: "node",
              label: "Offline runner",
              status: "unavailable",
              sessionHost: true,
            },
            {
              id: "node:nonhost",
              type: "node",
              label: "Hosting disabled",
              status: "available",
              sessionHost: false,
            },
          ],
        };
      }
      return { ok: true };
    });
    const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({ reconcileMutation }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move"],
      ["operator.read", "operator.write"],
    );
    const session = { ...activePlacementSession(), hasActiveRun: true };

    const moving = dialogs.track(pane.changeHeaderPlacement(session, "move"));
    await dialogs.waitFor(() => {
      expect(document.body.querySelector('[data-value="device:runner"]')).not.toBeNull();
    });
    expect(document.body.querySelector('[data-value="cloud:aws"]')).toBeNull();
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-value="device:saturated"]')?.disabled,
    ).toBe(true);
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-value="device:offline"]')?.disabled,
    ).toBe(true);
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-value="device:nonhost"]')?.disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain("No worker slots are available");
    expect(document.body.textContent).toContain("Device unavailable");
    expect(document.body.textContent).toContain("Session hosting is disabled");
    document.body.querySelector<HTMLButtonElement>('[data-value="device:runner"]')?.click();
    const moveButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Move session",
    );
    expect(moveButton).toBeDefined();
    moveButton?.click();
    await moving;

    expect(request).toHaveBeenCalledWith("sessions.move", {
      key: session.key,
      agentId: "main",
      expected: {
        generation: 1,
        environmentId: "worker:one",
        ownerEpoch: 1,
      },
      target: { kind: "device", deviceId: "runner" },
    });
    expect(request.mock.calls.some(([method]) => method === "node.list")).toBe(false);
    expect(reconcileMutation).toHaveBeenCalledWith("main");
  });

  it("moves an active placement to a selected profile machine", async () => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              machines: [
                { id: "standard", label: "Standard", default: true },
                { id: "beast", label: "Beast" },
              ],
            },
          ],
          environments: [],
        };
      }
      return { ok: true };
    });
    const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({ reconcileMutation }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move"],
      ["operator.admin", "operator.read", "operator.write"],
    );
    const session = activePlacementSession();

    const moving = dialogs.track(pane.changeHeaderPlacement(session, "move"));
    await dialogs.waitFor(() => {
      expect(document.body.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    });
    document.body.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]')?.click();
    document.body.querySelector<HTMLButtonElement>('[data-value="machine:beast"]')?.click();
    const moveButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Move session",
    );
    moveButton?.click();
    await moving;

    expect(request).toHaveBeenCalledWith("sessions.move", {
      key: session.key,
      agentId: "main",
      expected: {
        generation: 1,
        environmentId: "worker:one",
        ownerEpoch: 1,
      },
      target: { kind: "profile", profileId: "aws", machineClass: "beast" },
    });
    expect(reconcileMutation).toHaveBeenCalledWith("main");
  });

  it.each([
    {
      runtimeId: "openclaw",
      executionMode: "worker-turn",
      compatibleSingleMode: "worker-only",
      incompatibleSingleMode: "remote-only",
    },
    {
      runtimeId: "codex",
      executionMode: "remote-exec",
      compatibleSingleMode: "remote-only",
      incompatibleSingleMode: "worker-only",
    },
  ] as const)(
    "moves $runtimeId to the same two-mode cloud profile while preserving machine selection",
    async ({ runtimeId, executionMode, compatibleSingleMode, incompatibleSingleMode }) => {
      const request = dialogs.mockRequest(async (method: string) => {
        if (method === "environments.list") {
          return {
            profiles: [
              {
                id: "lifecycle-only",
                providerId: "crabbox",
              },
              {
                id: "worker-only",
                providerId: "crabbox",
                executionMode: "worker-turn",
                executionModes: ["worker-turn"],
              },
              {
                id: "remote-only",
                providerId: "crabbox",
                executionMode: "remote-exec",
                executionModes: ["remote-exec"],
              },
              {
                id: "aws",
                providerId: "crabbox",
                executionMode: "worker-turn",
                executionModes: ["worker-turn", "remote-exec"],
                machines: [
                  { id: "standard", label: "Standard", default: true },
                  { id: "beast", label: "Beast" },
                ],
              },
            ],
            environments: [],
          };
        }
        return { ok: true };
      });
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture({
          reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
        }),
      });
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
        ["sessions.move"],
        ["operator.admin", "operator.write"],
      );
      const session = {
        ...activePlacementSession(),
        agentRuntime: {
          id: runtimeId,
          cloudPlacementSupported: true,
          cloudPlacementExecutionMode: executionMode,
          source: "model",
        },
      } satisfies GatewaySessionRow;

      const moving = dialogs.track(pane.changeHeaderPlacement(session, "move"));
      await dialogs.waitFor(() => {
        expect(document.body.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
      });
      const incompatible = document.body.querySelector<HTMLButtonElement>(
        `[data-value="cloud:${incompatibleSingleMode}"]`,
      );
      expect(incompatible?.disabled).toBe(true);
      expect(incompatible?.title).toMatch(/compatible cloud worker|cannot use/i);
      const lifecycleOnly = document.body.querySelector<HTMLButtonElement>(
        '[data-value="cloud:lifecycle-only"]',
      );
      expect(lifecycleOnly?.disabled).toBe(true);
      expect(lifecycleOnly?.title).toMatch(/compatible cloud worker|cannot use/i);
      const compatibleSingle = document.body.querySelector<HTMLButtonElement>(
        `[data-value="cloud:${compatibleSingleMode}"]`,
      );
      expect(compatibleSingle?.disabled).toBe(false);
      const multiMode = document.body.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
      expect(multiMode?.disabled).toBe(false);
      multiMode?.click();
      document.body.querySelector<HTMLButtonElement>('[data-value="machine:beast"]')?.click();
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Move session")
        ?.click();
      await moving;

      expect(request).toHaveBeenCalledWith(
        "sessions.move",
        expect.objectContaining({
          target: {
            kind: "profile",
            profileId: "aws",
            machineClass: "beast",
          },
        }),
      );
    },
  );

  it("cancels offline-device continuation without opening a picker or sending an RPC", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move"],
      ["operator.read", "operator.write"],
    );

    const moving = dialogs.track(pane.changeHeaderPlacement(offlineDeviceSession(), "move"));
    const actions = await waitForConfirmDialogActions();
    expect(document.body.textContent).toContain(
      "Unsynced device files and in-flight work may be lost",
    );
    expect(document.body.textContent).toContain("last Gateway-synced state");
    answerConfirmDialog(actions, "cancel");
    await moving;

    expect(request).not.toHaveBeenCalled();
  });

  it("continues an offline device placement on the Gateway with exact abandonment", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({ reconcileMutation }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move"],
      ["operator.read", "operator.write"],
    );
    const session = offlineDeviceSession();

    const moving = dialogs.track(pane.changeHeaderPlacement(session, "move"));
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await moving;

    expect(request).toHaveBeenCalledWith("sessions.move", {
      key: session.key,
      agentId: "main",
      expected: {
        generation: session.placement.generation,
        environmentId: session.placement.environmentId,
        ownerEpoch: session.placement.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
      abandonSource: true,
    });
    expect(request).not.toHaveBeenCalledWith("environments.list", expect.anything());
    expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
    expect(reconcileMutation).toHaveBeenCalledWith("main");
  });

  it("keeps the offline placement visible when continuation fails", async () => {
    const request = dialogs.mockRequest(async () => {
      throw new Error("device teardown is still pending; retry Continue on Gateway");
    });
    const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({ reconcileMutation }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move"],
      ["operator.read", "operator.write"],
    );
    const session = offlineDeviceSession();

    const moving = dialogs.track(pane.changeHeaderPlacement(session, "move"));
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await moving;

    expect(session.placement.runner).toEqual({ kind: "device", status: "offline" });
    expect(state.lastError).toContain("retry Continue on Gateway");
    expect(reconcileMutation).toHaveBeenCalledWith("main");
  });

  it("disables paired-device moves for a runtime that cannot dispatch there", async () => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [],
          environments: [
            {
              id: "node:build-mac",
              type: "node",
              label: "Build Mac",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
        };
      }
      return { ok: true };
    });
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({
        reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
      }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move"],
      ["operator.admin", "operator.write"],
    );
    const session = {
      ...activePlacementSession(),
      agentRuntime: {
        id: "cloud-only",
        cloudPlacementSupported: true,
        devicePlacementSupported: false,
        source: "model",
      },
    } satisfies GatewaySessionRow;

    const moving = dialogs.track(pane.changeHeaderPlacement(session, "move"));
    await dialogs.waitFor(() => {
      expect(document.body.querySelector('[data-value="device:build-mac"]')).not.toBeNull();
    });
    const device = document.body.querySelector<HTMLButtonElement>(
      '[data-value="device:build-mac"]',
    );
    expect(device?.disabled).toBe(true);
    expect(device?.textContent).toContain("This runtime does not support paired devices");
    expect(device?.title).toBe("This runtime does not support paired devices");
    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    await moving;

    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
    expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });

  it.each([
    { runtimeId: "openclaw", executionMode: "worker-turn" },
    { runtimeId: "codex", executionMode: "remote-exec" },
  ] as const)(
    "moves a $runtimeId session to a supported paired device",
    async ({ runtimeId, executionMode }) => {
      const request = dialogs.mockRequest(async (method: string) => {
        if (method === "environments.list") {
          return {
            profiles: [],
            environments: [
              {
                id: "node:build-mac",
                type: "node",
                label: "Build Mac",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 1, available: 1 },
                invocableCommands: ["codex.exec-server.stdio.v1"],
                ...(executionMode === "remote-exec"
                  ? {
                      requiredNodeCommand: {
                        command: "codex.exec-server.stdio.v1",
                        state: "invocable",
                      },
                    }
                  : {}),
              },
            ],
          };
        }
        return { ok: true };
      });
      const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture({ reconcileMutation }),
      });
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
        ["sessions.move"],
        ["operator.admin", "operator.write"],
      );
      const session = {
        ...activePlacementSession(),
        agentRuntime: {
          id: runtimeId,
          cloudPlacementSupported: true,
          cloudPlacementExecutionMode: executionMode,
          devicePlacementSupported: true,
          devicePlacement:
            executionMode === "remote-exec"
              ? {
                  requiredNodeCommands: ["codex.exec-server.stdio.v1"],
                  consumesWorkerSlot: false,
                }
              : { requiredNodeCommands: [], consumesWorkerSlot: true },
          source: "model",
        },
      } satisfies GatewaySessionRow;

      const moving = dialogs.track(pane.changeHeaderPlacement(session, "move"));
      await dialogs.waitFor(() => {
        expect(document.body.querySelector('[data-value="device:build-mac"]')).not.toBeNull();
      });
      document.body.querySelector<HTMLButtonElement>('[data-value="device:build-mac"]')?.click();
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Move session")
        ?.click();
      await moving;

      expect(request).toHaveBeenCalledWith("sessions.move", {
        key: session.key,
        agentId: "main",
        expected: {
          generation: 1,
          environmentId: "worker:one",
          ownerEpoch: 1,
        },
        target: { kind: "device", deviceId: "build-mac" },
      });
      expect(reconcileMutation).toHaveBeenCalledWith("main");
      expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
    },
  );

  it.each([
    {
      name: "remote execution ignores saturated worker capacity when its command is enabled",
      runtimeId: "codex",
      executionMode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      availableSlots: 0,
      invocableCommands: ["codex.exec-server.stdio.v1"],
      commandState: "invocable",
      disabled: false,
    },
    {
      name: "worker execution remains disabled at capacity",
      runtimeId: "openclaw",
      executionMode: "worker-turn",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      availableSlots: 0,
      invocableCommands: [],
      commandState: undefined,
      disabled: true,
      reason: /worker slots/i,
    },
    {
      name: "declared remote execution remains disabled without Gateway command authority",
      runtimeId: "codex",
      executionMode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      availableSlots: 1,
      invocableCommands: [],
      commandState: "unauthorized",
      disabled: true,
      reason:
        "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.",
    },
  ] as const)("$name in the Move Session picker", async (scenario) => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [],
          environments: [
            {
              id: "node:build-mac",
              type: "node",
              label: "Build Mac",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: scenario.availableSlots },
              capabilities: ["codex.exec-server.stdio.v1"],
              invocableCommands: scenario.invocableCommands,
              ...(scenario.commandState
                ? {
                    requiredNodeCommand: {
                      command: "codex.exec-server.stdio.v1",
                      state: scenario.commandState,
                    },
                  }
                : {}),
            },
          ],
        };
      }
      return { ok: true };
    });
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({
        reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
      }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move"],
      ["operator.admin", "operator.write"],
    );
    const session = {
      ...activePlacementSession(),
      agentRuntime: {
        id: scenario.runtimeId,
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: scenario.executionMode,
        devicePlacementSupported: true,
        devicePlacement: {
          requiredNodeCommands: [...scenario.devicePlacement.requiredNodeCommands],
          consumesWorkerSlot: scenario.devicePlacement.consumesWorkerSlot,
        },
        source: "model",
      },
    } satisfies GatewaySessionRow;

    const moving = dialogs.track(pane.changeHeaderPlacement(session, "move"));
    await dialogs.waitFor(() =>
      expect(request).toHaveBeenCalledWith("environments.list", {
        runtimeId: scenario.runtimeId,
      }),
    );
    await dialogs.waitFor(() => {
      expect(document.body.querySelector('[data-value="device:build-mac"]')).not.toBeNull();
    });
    const device = document.body.querySelector<HTMLButtonElement>(
      '[data-value="device:build-mac"]',
    );
    expect(device?.disabled).toBe(scenario.disabled);
    if (scenario.reason !== undefined) {
      if (typeof scenario.reason === "string") {
        expect(device?.title).toBe(scenario.reason);
      } else {
        expect(device?.title).toMatch(scenario.reason);
      }
    }
    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    await moving;

    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });
});
