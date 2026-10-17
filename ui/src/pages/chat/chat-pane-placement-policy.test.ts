/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createPlacementPane,
  deviceFixture,
  retryPlacementSession,
} from "./chat-pane-placement.test-support.ts";
import { activePlacementSession } from "./chat-pane.test-support.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;
const expected = { generation: 1, environmentId: "worker:one", ownerEpoch: 1 };
const button = (value: string) =>
  document.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
function activeRow() {
  return { ...activePlacementSession(), sessionId: "policy-session" };
}
beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});
afterEach(() => dialogs.cleanup());
function fixture(row: GatewaySessionRow, fallbackAgentId = "main") {
  const { pane, state, request, reconcileMutation } = createPlacementPane(
    dialogs,
    async (method) =>
      method === "environments.list"
        ? {
            profiles: [
              {
                id: "required",
                providerId: "crabbox",
                machines: [{ id: "fast", label: "Fast" }],
                operatingSystems: ["linux", "windows"].map((id) => ({ id, label: id })),
              },
              { id: "other", providerId: "crabbox" },
            ],
            environments: [deviceFixture("runner")],
          }
        : { ok: true },
    ["operator.admin", "operator.read", "operator.write"],
    ["sessions.move", "sessions.dispatch", "sessions.reclaim"],
  );
  state.assistantAgentId = fallbackAgentId;
  state.sessionKey = row.key;
  state.currentSessionId = row.sessionId;
  state.sessionsResultAgentId = fallbackAgentId;
  state.sessionsResult = { ...createSessionsListResult(), sessions: [row] };
  const requireProfile = () => {
    pane.context.agents.state.agentsList!.sessionPlacement = {
      requiredProfile: { id: "required", providerId: "crabbox" },
    };
  };
  const run = () => dialogs.track(pane.handleHeaderSessionAction({ kind: "move-session" }, row));
  return { pane, state, request, reconcileMutation, requireProfile, run };
}
it.each(["before", "during"])("blocks settlement %s destination selection", async (stage) => {
  const row = activeRow();
  const { run, request, state } = fixture(row);
  if (stage === "before") {
    row.placement.workspaceResultReconciling = true;
    await run();
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  } else {
    const moving = run();
    await chooseProfile();
    row.placement.workspaceResultReconciling = true;
    submit();
    await moving;
    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  }
  expect(state.lastError).toContain("Finalizing worker workspace");
  if (stage === "before") {
    delete row.placement.workspaceResultReconciling;
    const moving = run();
    await chooseProfile();
    submit();
    await moving;
    expect(request).toHaveBeenCalledWith("sessions.move", expect.objectContaining({ expected }));
  }
});

it("retains explicit offline-device abandonment with a pending workspace result", async () => {
  const row = activeRow();
  row.placement.workspaceResultReconciling = true;
  row.placement.runner = { kind: "device", status: "offline" };
  const { run, request } = fixture(row);
  const moving = run();
  answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
  await moving;
  expect(request).toHaveBeenCalledWith("sessions.move", {
    key: row.key,
    agentId: "main",
    expected,
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
  await dialogs.waitFor(() => expect(button("cloud:required")).not.toBeNull());
  button("cloud:required")!.click();
  flush();
}
function submit() {
  document.querySelector<HTMLButtonElement>('openclaw-modal-dialog button[type="submit"]')!.click();
}

it.each(["dispatch", "move"] as const)(
  "permits %s to required profile defaults, not an override",
  async (mode) => {
    const row = mode === "move" ? activeRow() : localRow();
    const { run, request, requireProfile } = fixture(row);
    requireProfile();
    const operation = run();
    await chooseProfile();
    expect(button("device:runner")).toMatchObject({ disabled: true });
    expect(button("cloud:other")).toMatchObject({ disabled: true });
    const gateway = button("gateway");
    if (mode === "move") {
      expect(gateway!.disabled).toBe(true);
      expect(gateway!.getAttribute("aria-pressed")).toBe("false");
    } else {
      expect(gateway).toBeNull();
    }
    const overrides = document.querySelectorAll('[data-value^="machine:"], [data-value^="os:"]');
    expect(overrides).toHaveLength(0);
    submit();
    await operation;
    expect(request).toHaveBeenCalledWith(mode === "move" ? "sessions.move" : "sessions.dispatch", {
      key: row.key,
      agentId: "main",
      ...(mode === "move"
        ? { expected, target: { kind: "profile", profileId: "required" } }
        : { profileId: "required" }),
    });
  },
);

it("revalidates a same-profile machine override when required policy appears during selection", async () => {
  const { run, request, requireProfile } = fixture(activeRow());
  const operation = run();
  await chooseProfile();
  button("machine:fast")!.click();
  flush();
  requireProfile();
  submit();
  await operation;
  expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
});

it.each(["dispatch", "move", "retry", "stop"] as const)(
  "keeps explicit or fallback global-session agent scope for %s",
  async (mode) => {
    for (const agentId of ["writer", undefined]) {
      const row: GatewaySessionRow = {
        ...{ dispatch: localRow, move: activeRow, retry: retryPlacementSession, stop: activeRow }[
          mode
        ](),
        key: "global",
        agentId,
      };
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
      const method = { dispatch: "dispatch", move: "move", retry: "move", stop: "reclaim" }[mode];
      const mutation = request.mock.calls.find(([called]) => called === `sessions.${method}`);
      expect(mutation?.[1]).toMatchObject({ key: "global", agentId: "writer" });
      expect(reconcileMutation).toHaveBeenCalledWith("writer");
    }
  },
);
