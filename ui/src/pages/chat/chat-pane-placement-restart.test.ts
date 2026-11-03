/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { row } from "./chat-outbox-recovery.test-support.ts";
import { createPlacementPane } from "./chat-pane-placement.test-support.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;

beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});

afterEach(() => dialogs.cleanup());

function clickChoice(value: string) {
  const button = document.body.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
  button?.click();
  flush();
}

const profile = {
  id: "aws",
  providerId: "crabbox",
  operatingSystems: [{ id: "windows/wsl2", label: "Windows (WSL2)", default: true }],
  machines: [{ id: "fast", label: "Fast", os: "windows/wsl2", default: true }],
};

it.each([
  { target: "cloud", fails: false },
  { target: "gateway", fails: false },
  { target: "gateway", fails: true },
] as const)(
  "restarts a failed placement on $target without creating a session (fails=$fails)",
  async ({ target, fails }) => {
    const recovery = createDeferred<{ ok: true }>();
    const { pane, state, request, reconcileMutation } = createPlacementPane(
      dialogs,
      async (method: string) => {
        if (method === "environments.list") {
          return { profiles: [profile], environments: [] };
        }
        if (method === "sessions.dispatch" || method === "sessions.reclaim") {
          return recovery.promise;
        }
        return { ok: true };
      },
      ["operator.admin", "operator.read", "operator.write"],
      ["sessions.dispatch", "sessions.reclaim"],
    );
    const session = row("agent:main:failed-worker", {
      sessionId: "failed-worker-session",
      placement: {
        state: "failed",
        generation: 2,
        createdAtMs: 1,
        updatedAtMs: 2,
        stateChangedAtMs: 2,
        recoveryError: "worker disappeared",
        recoveryAction: "restart",
      },
    });
    state.sessionKey = session.key;
    state.currentSessionId = session.sessionId;
    state.sessionsResult = { ...createSessionsListResult(), sessions: [session] };
    state.chatRunError = { summary: "Previous worker failed" };
    state.lastError = state.chatError = "Previous restart failed";

    const restarting = dialogs.track(pane.changeHeaderPlacement(session, "recover"));
    try {
      await dialogs.waitFor(() =>
        expect(document.body.querySelector('[data-value="cloud:aws"]')).not.toBeNull(),
      );
      expect(document.body.textContent).toContain(
        "Changes that the previous worker did not upload may be lost.",
      );
      clickChoice(target === "cloud" ? "cloud:aws" : "gateway");
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Restart session")
        ?.click();
      const cloud = target === "cloud";
      const targetParams = cloud
        ? { profileId: "aws", os: "windows/wsl2", machineClass: "fast" }
        : { recoverToGateway: { expectedGeneration: 2 } };
      await dialogs.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          cloud ? "sessions.dispatch" : "sessions.reclaim",
          { key: session.key, agentId: "main", ...targetParams },
          ...(cloud ? [] : [{ timeoutMs: null }]),
        ),
      );
      expect(state).toMatchObject({ chatRunError: null, lastError: null, chatError: null });
      if (fails) {
        recovery.reject(new Error("Saved workspace could not be restored"));
      } else {
        recovery.resolve({ ok: true });
      }
      await restarting;
      expect(state.lastError).toBe(fails ? "Saved workspace could not be restored" : null);

      if (target === "gateway") {
        expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
      }
      expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
      expect(reconcileMutation).toHaveBeenCalledWith("main");
    } finally {
      recovery.resolve({ ok: true });
    }
  },
);
