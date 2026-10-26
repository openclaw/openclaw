/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { activePlacementSession, createTestChatPane } from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;
beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});
afterEach(() => dialogs.cleanup());
function fixture(row: GatewaySessionRow, fallbackAgentId = "main") {
  const request = dialogs.mockRequest(async (method: string, _params?: unknown) =>
    method === "environments.list"
      ? {
          profiles: [
            {
              id: "required",
              providerId: "crabbox",
              machines: [{ id: "fast", label: "Fast" }],
              operatingSystems: [
                { id: "linux", label: "Linux" },
                { id: "windows", label: "Windows" },
              ],
            },
            { id: "other", providerId: "crabbox" },
          ],
          environments: [
            {
              id: "node:runner",
              type: "node",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
        }
      : { ok: true },
  );
  const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture({ reconcileMutation }),
  });
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
    ["sessions.move", "sessions.dispatch", "sessions.reclaim"],
    ["operator.admin", "operator.read", "operator.write"],
  );
  state.assistantAgentId = fallbackAgentId;
  state.sessionKey = row.key;
  state.currentSessionId = row.sessionId;
  state.sessionsResultAgentId = fallbackAgentId;
  state.sessionsResult = { ...createSessionsListResult(), sessions: [row] };
  const requireProfile = () => {
    pane.context.agents.state.agentsList = {
      ...pane.context.agents.state.agentsList!,
      sessionPlacement: { requiredProfile: { id: "required", providerId: "crabbox" } },
    };
  };
  return {
    pane,
    state,
    row,
    request,
    reconcileMutation,
    requireProfile,
    run: () => dialogs.track(pane.handleHeaderSessionAction({ kind: "move-session" }, row)),
  };
}
it("waits for workspace settlement before offering a move", async () => {
  const row = { ...activePlacementSession(), sessionId: "settling-session" };
  row.placement.workspaceResultReconciling = true;
  const { run, request, state } = fixture(row);
  const blocked = run();
  await blocked;
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(state.lastError).toContain("Finalizing worker workspace");
  expect(request).not.toHaveBeenCalled();

  delete row.placement.workspaceResultReconciling;
  const moving = run();
  await chooseProfile();
  submit();
  await moving;
  expect(request).toHaveBeenCalledWith(
    "sessions.move",
    expect.objectContaining({
      expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
    }),
  );
});

it("rechecks workspace settlement after choosing the destination", async () => {
  const row = { ...activePlacementSession(), sessionId: "settling-session" };
  const { run, request, state } = fixture(row);
  const moving = run();
  await chooseProfile();
  row.placement.workspaceResultReconciling = true;
  submit();
  await moving;
  expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  expect(state.lastError).toContain("Finalizing worker workspace");
});

it("retains explicit offline-device abandonment with a pending workspace result", async () => {
  const row = { ...activePlacementSession(), sessionId: "settling-session" };
  row.placement.workspaceResultReconciling = true;
  row.placement.runner = { kind: "device", status: "offline" };
  const { run, request } = fixture(row);
  const moving = run();
  answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
  await moving;
  expect(request).toHaveBeenCalledWith("sessions.move", {
    key: row.key,
    agentId: "main",
    expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
    target: { kind: "gateway" },
    abandonSource: true,
  });
  expect(request).not.toHaveBeenCalledWith("environments.list", expect.anything());
});

function localRow(): GatewaySessionRow {
  return {
    key: "agent:main:policy",
    sessionId: "policy-session",
    kind: "direct",
    updatedAt: 1,
    worktree: { id: "policy-workspace", branch: "policy", repoRoot: "/example/project" },
  };
}
async function chooseProfile() {
  await dialogs.waitFor(() =>
    expect(document.querySelector('[data-value="cloud:required"]')).not.toBeNull(),
  );
  document.querySelector<HTMLButtonElement>('[data-value="cloud:required"]')!.click();
  flush();
}
function submit() {
  document.querySelector<HTMLButtonElement>('openclaw-modal-dialog button[type="submit"]')!.click();
}

it.each(["dispatch", "move"] as const)(
  "permits %s to required profile defaults, not an override",
  async (mode) => {
    const row =
      mode === "move" ? { ...activePlacementSession(), sessionId: "policy-session" } : localRow();
    const { run, request, requireProfile } = fixture(row);
    requireProfile();
    const operation = run();
    await chooseProfile();
    expect(
      document.querySelector<HTMLButtonElement>('[data-value="device:runner"]')!.disabled,
    ).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-value="cloud:other"]')!.disabled).toBe(
      true,
    );
    const gateway = document.querySelector<HTMLButtonElement>('[data-value="gateway"]');
    if (mode === "move") {
      expect(gateway!.disabled).toBe(true);
      expect(gateway!.getAttribute("aria-pressed")).toBe("false");
    } else {
      expect(gateway).toBeNull();
    }
    expect(document.querySelector(".session-move__configuration")).toBeNull();
    submit();
    await operation;
    expect(request).toHaveBeenCalledWith(
      mode === "move" ? "sessions.move" : "sessions.dispatch",
      mode === "move"
        ? {
            key: row.key,
            agentId: "main",
            expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
            target: { kind: "profile", profileId: "required" },
          }
        : { key: row.key, agentId: "main", profileId: "required" },
    );
  },
);

it("revalidates a same-profile machine override when required policy appears during selection", async () => {
  const { run, request, requireProfile } = fixture({
    ...activePlacementSession(),
    sessionId: "policy-session",
  });
  const operation = run();
  await chooseProfile();
  expect(document.querySelector(".session-move__fixed-value")?.textContent).toContain("Fast");
  expect(
    document.querySelector<HTMLButtonElement>('openclaw-modal-dialog button[type="submit"]')!
      .disabled,
  ).toBe(false);
  requireProfile();
  submit();
  await operation;
  expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
});

it.each(["dispatch", "move", "retry", "stop"] as const)(
  "keeps explicit or fallback global-session agent scope for %s",
  async (mode) => {
    for (const agentId of ["writer", undefined]) {
      const row: GatewaySessionRow =
        mode === "dispatch"
          ? { ...localRow(), key: "global", agentId }
          : { ...activePlacementSession(), key: "global", agentId, sessionId: "writer-global" };
      if (mode === "retry" && row.placement?.state === "active") {
        row.placement = { ...row.placement, state: "draining", generation: 2 };
        row.placementMove = {
          target: { kind: "gateway" },
          updatedAtMs: 2,
          error: "Sync failed",
          retry: {
            expected: { generation: 1, environmentId: "worker:one", ownerEpoch: 1 },
            target: { kind: "gateway" },
          },
        };
      }
      const { pane, run, request, reconcileMutation } = fixture(row, "writer");
      const operation =
        mode === "stop"
          ? dialogs.track(pane.handleHeaderSessionAction({ kind: "stop-cloud-worker" }, row))
          : run();
      if (mode === "stop") {
        answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
      } else if (mode !== "retry") {
        await chooseProfile();
        submit();
      }
      await operation;
      const mutation = request.mock.calls.find(
        ([method]) =>
          method ===
          (mode === "dispatch"
            ? "sessions.dispatch"
            : mode === "stop"
              ? "sessions.reclaim"
              : "sessions.move"),
      );
      expect(mutation?.[1]).toMatchObject({ key: "global", agentId: "writer" });
      expect(reconcileMutation).toHaveBeenCalledWith("writer");
    }
  },
);
