/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSummary,
  WorkerEnvironmentProfileSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createPlacementPane,
  deviceFixture,
  type AsyncRequest,
} from "./chat-pane-placement.test-support.ts";
import {
  activePlacementSession as placementSession,
  offlineDeviceSession,
  createTestChatPane,
  createGatewayBrowserClientFixture,
} from "./chat-pane.test-support.ts";

function activePlacementSession() {
  return { ...placementSession(), sessionId: "placement-session" };
}

function moveFixture(handler?: AsyncRequest, scopes?: string[]) {
  return createPlacementPane(dialogs, handler, scopes);
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
function clickButton(label: string, requireButton = false) {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (requireButton) {
    expect(button).toBeDefined();
  }
  button?.click();
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
  clickButton(label, true);
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
    clickButton("Move session", true);
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
              { id: "lifecycle-only", providerId: "crabbox" },
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
        target: { kind: "profile", profileId: "aws", machineClass: "beast" },
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

  it.each(["unsupported runtime", "supported", "unauthorized command"] as const)(
    "gates paired-device moves: %s",
    async (scenario) => {
      const session =
        scenario === "unsupported runtime"
          ? ({
              ...activePlacementSession(),
              agentRuntime: {
                id: "cloud-only",
                cloudPlacementSupported: true,
                devicePlacementSupported: false,
                source: "model",
              },
            } satisfies GatewaySessionRow)
          : codexDeviceSession();
      const environment = deviceFixture("build-mac", "Build Mac");
      if (scenario !== "unsupported runtime") {
        const authorized = scenario === "supported";
        environment.invocableCommands = authorized ? ["codex.exec-server.stdio.v1"] : [];
        environment.requiredNodeCommand = {
          command: "codex.exec-server.stdio.v1",
          state: authorized ? "invocable" : "unauthorized",
        };
        if (!authorized) {
          environment.capabilities = ["codex.exec-server.stdio.v1"];
        }
      }
      const { pane, request, reconcileMutation } = moveFixture(catalogRequest([], [environment]), [
        "operator.admin",
        "operator.write",
      ]);
      const moving = dialogs.track(startMove(pane, session));
      if (scenario === "unauthorized command") {
        await dialogs.waitFor(() =>
          expect(request).toHaveBeenCalledWith("environments.list", { runtimeId: "codex" }),
        );
      }
      await waitForOption("device:build-mac");
      if (scenario === "supported") {
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
      } else {
        const reason =
          scenario === "unsupported runtime"
            ? "This runtime does not support paired devices"
            : "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.";
        expect(option("device:build-mac")).toMatchObject({ disabled: true, title: reason });
        if (scenario === "unsupported runtime") {
          expect(option("device:build-mac")?.textContent).toContain(reason);
        }
        clickButton("Cancel");
        await moving;
        expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
      }
      if (scenario !== "unauthorized command") {
        expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
      }
    },
  );
});

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

  it("does not move a superseded active source in place", async () => {
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

describe("cloud placement stop confirmation authority", () => {
  it.each([
    "unchanged",
    "read-only",
    "method-removed",
    "replacement",
    "busy",
    "offline-device",
    "new-placement",
    "removed",
  ] as const)("uses the current owner state after confirmation (%s)", async (change) => {
    const { pane, state, request, reconcileMutation } = createPlacementPane(
      dialogs,
      undefined,
      ["operator.write"],
      ["sessions.reclaim"],
    );
    const client = pane.context.gateway.snapshot.client;
    const session = activePlacementSession();
    state.sessionKey = session.key;
    state.currentSessionId = session.sessionId;
    state.sessionsResult = { ...createSessionsListResult(), sessions: [session] };
    const stopping = dialogs.track(pane.changeHeaderPlacement(session, "reclaim"));
    const actions = await waitForConfirmDialogActions();
    const current = { ...session };
    if (change === "read-only" || change === "method-removed") {
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
        change === "method-removed" ? [] : ["sessions.reclaim"],
        change === "read-only" ? ["operator.read"] : ["operator.write"],
      );
    }
    if (change === "replacement") {
      current.sessionId = "replacement-session";
    }
    if (change === "busy") {
      current.hasActiveRun = true;
    }
    if (change === "offline-device") {
      current.placement = {
        ...current.placement,
        runner: { kind: "device", status: "offline" },
      };
    }
    if (change === "new-placement") {
      current.placement = { ...current.placement, generation: 2 };
    }
    state.sessionsResult = {
      ...createSessionsListResult(),
      sessions: change === "removed" ? [] : [current],
    };
    expect(pane.context.gateway.snapshot.client).toBe(client);
    answerConfirmDialog(actions, "confirm");
    await stopping;
    if (change === "unchanged") {
      expect(pane.context.placementStartup.pause).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        "sessions.reclaim",
        { key: session.key, agentId: "main" },
        { timeoutMs: null },
      );
      expect(reconcileMutation).toHaveBeenCalledWith("main");
    } else {
      expect(pane.context.placementStartup.pause).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalledWith(
        "sessions.reclaim",
        expect.anything(),
        expect.anything(),
      );
      expect(reconcileMutation).not.toHaveBeenCalled();
      expect(state.chatError).toBeTruthy();
    }
  });
});
