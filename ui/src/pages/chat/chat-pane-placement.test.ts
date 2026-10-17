/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSummary,
  WorkerEnvironmentProfileSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  activePlacementSession as placementSession,
  offlineDeviceSession,
  createTestChatPane,
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";

function activePlacementSession() {
  return { ...placementSession(), sessionId: "placement-session" };
}

type AsyncRequest = (...args: Parameters<GatewayRequestHandler>) => Promise<unknown>;
function moveFixture(
  handler: AsyncRequest = async () => ({ ok: true }),
  scopes = ["operator.read", "operator.write"],
) {
  const request = dialogs.mockRequest(handler);
  const reconcileMutation = vi.fn<SessionCapability["reconcileMutation"]>(async () => ({
    status: "refreshed",
  }));
  const fixture = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture({ reconcileMutation }),
  });
  fixture.pane.context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.move"], scopes);
  return { ...fixture, request, reconcileMutation };
}

function deviceFixture(
  id: string,
  label: string,
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary {
  return {
    id: `node:${id}`,
    type: "node",
    label,
    status: "available",
    sessionHost: true,
    workerSlots: { total: 1, available: 1 },
    ...overrides,
  };
}

function catalogRequest(
  profiles: WorkerEnvironmentProfileSummary[],
  environments: EnvironmentSummary[],
): AsyncRequest {
  return async (method) =>
    method === "environments.list" ? { profiles, environments } : { ok: true };
}

const option = (value: string) =>
  document.body.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
async function waitForOption(value: string) {
  await dialogs.waitFor(() => expect(option(value)).not.toBeNull());
}
function selectOption(value: string) {
  option(value)?.click();
  flush();
}
function clickButton(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === label)
    ?.click();
}

function codexDeviceSession(): GatewaySessionRow {
  return {
    ...activePlacementSession(),
    agentRuntime: {
      id: "codex",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "remote-exec",
      devicePlacementSupported: true,
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      source: "model",
    },
  };
}

function startMove(pane: ReturnType<typeof createTestChatPane>["pane"], row: GatewaySessionRow) {
  const selected = { ...row, sessionId: row.sessionId ?? "placement-session" };
  pane.state!.sessionKey = selected.key;
  pane.state!.currentSessionId = selected.sessionId;
  pane.state!.sessionsResult = { ...createSessionsListResult(), sessions: [selected] };
  return pane.changeHeaderPlacement(selected, "move");
}

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

function repositoryRecoveryFixture(placementState: "local" | undefined) {
  const { pane, state, request, reconcileMutation } = moveFixture(
    catalogRequest(
      [{ id: "aws", providerId: "crabbox" }],
      [deviceFixture("runner", "Writer runner")],
    ),
  );
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
  await waitForOption("device:runner");
  expect(option("gateway")).toBeNull();
  selectOption("device:runner");
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
    { placement: "local", outcome: "refresh failure" },
  ] as const)(
    "recovers a repository session with $placement placement: $outcome",
    async ({ placement, outcome }) => {
      const { pane, state, session, request, reconcileMutation } =
        repositoryRecoveryFixture(placement);
      if (outcome === "refresh failure") {
        reconcileMutation.mockResolvedValueOnce({
          status: "failed",
          error: "Worker session refresh unavailable",
        });
      }
      const dispatching = dialogs.track(pane.changeHeaderPlacement(session, "recover"));
      await selectRepositoryWorker();
      answerWorkerPicker("Continue on worker");
      await dispatching;

      expect(request).toHaveBeenCalledWith("environments.list", { runtimeId: "openclaw" });
      expect(request).toHaveBeenCalledWith("sessions.dispatch", {
        key: session.key,
        agentId: "main",
        deviceId: "runner",
      });
      expect(reconcileMutation).toHaveBeenCalledWith("main");
      expect(state.lastError).toBe(
        outcome === "refresh failure" ? "Worker session refresh unavailable" : null,
      );
      expect(pane.headerPresentation.placementRestartingKey).toBeNull();
    },
  );

  it("does not redirect a Move that appears while the recovery picker is open", async () => {
    const { pane, session, request } = repositoryRecoveryFixture("local");
    const operation = dialogs.track(pane.changeHeaderPlacement(session, "recover"));
    await selectRepositoryWorker();
    session.placementMove = {
      target: { kind: "gateway" },
      updatedAtMs: 2,
      error: "Move needs recovery",
      retry: {
        expected: { generation: 1, environmentId: "worker:source", ownerEpoch: 1 },
        target: { kind: "gateway" },
      },
    };
    answerWorkerPicker("Continue on worker");
    await operation;
    expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
  });

  it("does not open worker dispatch for an archived repository session", async () => {
    const { pane, session, request } = repositoryRecoveryFixture("local");
    await pane.changeHeaderPlacement({ ...session, archived: true }, "recover");

    expect(request).not.toHaveBeenCalled();
    expect(document.body.querySelector("dialog[open]")).toBeNull();
  });

  it("shows authoritative device targets to writers and moves to the selected device", async () => {
    const { pane, request, reconcileMutation } = moveFixture(
      catalogRequest(
        [{ id: "aws", providerId: "crabbox" }],
        [
          deviceFixture("runner", "Writer runner"),
          deviceFixture("saturated", "Busy runner", { workerSlots: { total: 2, available: 0 } }),
          deviceFixture("offline", "Offline runner", {
            status: "unavailable",
            workerSlots: undefined,
          }),
          deviceFixture("nonhost", "Hosting disabled", {
            sessionHost: false,
            workerSlots: undefined,
          }),
        ],
      ),
    );
    const session = { ...activePlacementSession(), hasActiveRun: true };

    const moving = dialogs.track(startMove(pane, session));
    await waitForOption("device:runner");
    expect(option("cloud:aws")).toBeNull();
    expect(option("device:saturated")?.disabled).toBe(true);
    expect(option("device:offline")?.disabled).toBe(true);
    expect(option("device:nonhost")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("No worker slots are available");
    expect(document.body.textContent).toContain("Device unavailable");
    expect(document.body.textContent).toContain("Session hosting is disabled");
    selectOption("device:runner");
    const moveButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Move session",
    );
    expect(moveButton).toBeDefined();
    moveButton?.click();
    await moving;

    expect(request).toHaveBeenCalledWith("sessions.move", {
      key: session.key,
      agentId: "main",
      expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
      target: { kind: "device", deviceId: "runner" },
    });
    expect(request.mock.calls.some(([method]) => method === "node.list")).toBe(false);
    expect(reconcileMutation).toHaveBeenCalledWith("main");
  });

  it("moves codex to a two-mode cloud profile while preserving machine selection", async () => {
    const { pane, request } = moveFixture(
      async (method: string) => {
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
      },
      ["operator.admin", "operator.write"],
    );
    const session = {
      ...activePlacementSession(),
      agentRuntime: {
        id: "codex",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "remote-exec",
        source: "model",
      },
    } satisfies GatewaySessionRow;

    const moving = dialogs.track(startMove(pane, session));
    await waitForOption("cloud:aws");
    const incompatible = option("cloud:worker-only");
    expect(incompatible?.disabled).toBe(true);
    expect(incompatible?.title).toMatch(/compatible cloud worker|cannot use/i);
    const lifecycleOnly = option("cloud:lifecycle-only");
    expect(lifecycleOnly?.disabled).toBe(true);
    expect(lifecycleOnly?.title).toMatch(/compatible cloud worker|cannot use/i);
    const compatibleSingle = option("cloud:remote-only");
    expect(compatibleSingle?.disabled).toBe(false);
    const multiMode = option("cloud:aws");
    expect(multiMode?.disabled).toBe(false);
    multiMode?.click();
    flush();
    selectOption("machine:beast");
    clickButton("Move session");
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
  });

  it("cancels offline-device continuation without opening a picker or sending an RPC", async () => {
    const { pane, request } = moveFixture();

    const moving = dialogs.track(startMove(pane, offlineDeviceSession()));
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
    const { pane, request, reconcileMutation } = moveFixture();
    const session = offlineDeviceSession();

    const moving = dialogs.track(startMove(pane, session));
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
    const { pane, state, reconcileMutation } = moveFixture(async () => {
      throw new Error("device teardown is still pending; retry Continue on Gateway");
    });
    const session = offlineDeviceSession();

    const moving = dialogs.track(startMove(pane, session));
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await moving;

    expect(session.placement.runner).toEqual({ kind: "device", status: "offline" });
    expect(state.lastError).toContain("retry Continue on Gateway");
    expect(reconcileMutation).toHaveBeenCalledWith("main");
  });

  it("disables paired-device moves for a runtime that cannot dispatch there", async () => {
    const { pane, request } = moveFixture(
      catalogRequest([], [deviceFixture("build-mac", "Build Mac")]),
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

    const moving = dialogs.track(startMove(pane, session));
    await waitForOption("device:build-mac");
    const device = option("device:build-mac");
    expect(device?.disabled).toBe(true);
    expect(device?.textContent).toContain("This runtime does not support paired devices");
    expect(device?.title).toBe("This runtime does not support paired devices");
    clickButton("Cancel");
    await moving;

    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
    expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });

  it("moves a codex session to a supported paired device", async () => {
    const { pane, request, reconcileMutation } = moveFixture(
      catalogRequest(
        [],
        [
          {
            ...deviceFixture("build-mac", "Build Mac"),
            invocableCommands: ["codex.exec-server.stdio.v1"],
            requiredNodeCommand: { command: "codex.exec-server.stdio.v1", state: "invocable" },
          },
        ],
      ),
      ["operator.admin", "operator.write"],
    );
    const session = codexDeviceSession();
    const moving = dialogs.track(startMove(pane, session));
    await waitForOption("device:build-mac");
    selectOption("device:build-mac");
    clickButton("Move session");
    await moving;
    expect(request).toHaveBeenCalledWith("sessions.move", {
      key: session.key,
      agentId: "main",
      expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
      target: { kind: "device", deviceId: "build-mac" },
    });
    expect(reconcileMutation).toHaveBeenCalledWith("main");
    expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });

  it("keeps declared remote execution disabled without Gateway command authority", async () => {
    const { pane, request } = moveFixture(
      catalogRequest(
        [],
        [
          {
            ...deviceFixture("build-mac", "Build Mac"),
            capabilities: ["codex.exec-server.stdio.v1"],
            invocableCommands: [],
            requiredNodeCommand: { command: "codex.exec-server.stdio.v1", state: "unauthorized" },
          },
        ],
      ),
      ["operator.admin", "operator.write"],
    );
    const moving = dialogs.track(startMove(pane, codexDeviceSession()));
    await dialogs.waitFor(() =>
      expect(request).toHaveBeenCalledWith("environments.list", { runtimeId: "codex" }),
    );
    await waitForOption("device:build-mac");
    expect(option("device:build-mac")?.disabled).toBe(true);
    expect(option("device:build-mac")?.title).toBe(
      "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.",
    );
    clickButton("Cancel");
    await moving;
    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });
});

// The ordinary local-session menu uses dispatch, never active-source move or abort.
describe("local session placement actions", () => {
  function localFixture() {
    const fixture = repositoryRecoveryFixture(undefined);
    fixture.session.repositoryWorkspaceId = undefined;
    fixture.session.worktree = { id: "workspace-1", branch: "work", repoRoot: "/example/project" };
    return fixture;
  }

  it.each(["replacement", "busy", "read-only", "reconnect", "required-profile"] as const)(
    "does not dispatch after the picker becomes stale: %s",
    async (change) => {
      const { pane, session, state, request } = localFixture();
      const moving = dialogs.track(
        pane.handleHeaderSessionAction({ kind: "move-session" }, session),
      );
      await selectRepositoryWorker();
      const current = { ...session };
      if (change === "replacement") {
        current.sessionId = "replacement";
      }
      if (change === "busy") {
        current.hasActiveRun = true;
      }
      if (change === "read-only") {
        pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
          ["sessions.dispatch"],
          ["operator.read"],
        );
      }
      if (change === "reconnect") {
        pane.context.gateway.snapshot.client = createGatewayBrowserClientFixture({ request });
      }
      if (change === "required-profile") {
        pane.context.agents.state.agentsList = {
          ...pane.context.agents.state.agentsList!,
          sessionPlacement: { requiredProfile: { id: "required", providerId: "device" } },
        };
      }
      state.sessionsResult = { ...createSessionsListResult(), sessions: [current] };
      answerWorkerPicker("Continue on worker");
      await moving;
      expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    },
  );

  it.each(["in-place"] as const)("does not move a superseded active source (%s)", async () => {
    const { pane, request } = localFixture();
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move"],
      ["operator.write"],
    );
    const session = activePlacementSession();
    const moving = dialogs.track(startMove(pane, session));
    await dialogs.waitFor(() => expect(option("gateway")).not.toBeNull());
    session.placement.generation = 2;
    clickButton("Move session");
    await moving;
    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });
  it("does not dispatch a profile after administrator access is revoked", async () => {
    const { pane, session, request } = localFixture();
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.dispatch"],
      ["operator.admin", "operator.write"],
    );
    // The catalog's profile explicitly supports the selected runtime.
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, ...args) =>
      method === "environments.list"
        ? {
            profiles: [{ id: "cloud", providerId: "crabbox", executionModes: ["worker-turn"] }],
            environments: [],
          }
        : original(method, ...args),
    );
    const moving = dialogs.track(pane.handleHeaderSessionAction({ kind: "move-session" }, session));
    await dialogs.waitFor(() => expect(option("cloud:cloud")).not.toBeNull());
    option("cloud:cloud")!.click();
    flush();
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.dispatch"],
      ["operator.write"],
    );
    answerWorkerPicker("Continue on worker");
    await moving;
    expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
  });
});
