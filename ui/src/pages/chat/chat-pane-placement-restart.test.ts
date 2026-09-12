/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;

beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});

afterEach(() => dialogs.cleanup());

describe("chat pane placement restart", () => {
  it.each([
    { target: "cloud", fails: false },
    { target: "gateway", fails: false },
    { target: "gateway", fails: true },
  ] as const)(
    "restarts a failed placement on $target without creating a session (fails=$fails)",
    async ({ target, fails }) => {
      const recovery = createDeferred<{ ok: true }>();
      const request = dialogs.mockRequest(async (method: string) => {
        if (method === "environments.list") {
          return {
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                operatingSystems: [
                  { id: "linux", label: "Linux", default: true },
                  { id: "windows/wsl2", label: "Windows (WSL2)" },
                ],
                machines: [
                  { id: "tiny", label: "Tiny", os: "linux", default: true },
                  { id: "tiny", label: "Tiny", os: "windows/wsl2", default: true },
                  { id: "fast", label: "Fast", os: "windows/wsl2" },
                ],
              },
            ],
            environments: [],
          };
        }
        if (method === "sessions.dispatch" || method === "sessions.reclaim") {
          return recovery.promise;
        }
        return { ok: true };
      });
      const refreshReplacement = vi.fn(async () => undefined);
      const { pane, state } = createTestChatPane({
        client: { request } as unknown as GatewayBrowserClient,
        sessions: { refreshReplacement } as unknown as SessionCapability,
      });
      pane.context.gateway.snapshot.hello = {
        features: { methods: ["sessions.dispatch", "sessions.reclaim"] },
        auth: {
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
      } as never;
      const session: GatewaySessionRow = {
        key: "agent:main:failed-worker",
        label: "Failed worker session",
        kind: "direct",
        updatedAt: 0,
        placement: {
          state: "failed",
          generation: 2,
          createdAtMs: 1,
          updatedAtMs: 2,
          stateChangedAtMs: 2,
          recoveryError: "worker disappeared",
          recoveryAction: "restart",
        },
      };
      state.chatRunError = { summary: "Previous worker failed" };
      state.lastError = state.chatError = "Previous restart failed";

      const restarting = dialogs.track(pane.restartHeaderPlacement(session));
      try {
        await dialogs.waitFor(() => {
          expect(document.body.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
        });
        expect(document.body.textContent).toContain(
          "Changes that the previous worker did not upload may be lost.",
        );
        if (target === "cloud") {
          document.body.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]')?.click();
          document.body.querySelector<HTMLButtonElement>('[data-value="os:windows/wsl2"]')?.click();
          document.body.querySelector<HTMLButtonElement>('[data-value="machine:fast"]')?.click();
        } else {
          const local = document.body.querySelector<HTMLButtonElement>('[data-value="gateway"]');
          expect(local?.textContent).toContain("Gateway · local");
          local?.click();
        }
        const restartButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.trim() === "Restart session",
        );
        restartButton?.click();
        await dialogs.waitFor(() => {
          expect(request).toHaveBeenCalledWith(
            target === "cloud" ? "sessions.dispatch" : "sessions.reclaim",
            expect.objectContaining({ key: session.key }),
            ...(target === "cloud" ? [] : [{ timeoutMs: null }]),
          );
        });
        expect(state.chatRunError).toBeNull();
        expect(state.lastError).toBeNull();
        expect(state.chatError).toBeNull();
        if (fails) {
          recovery.reject(new Error("Saved workspace could not be restored"));
        } else {
          recovery.resolve({ ok: true });
        }
        await restarting;
        expect(state.lastError).toBe(fails ? "Saved workspace could not be restored" : null);

        if (target === "cloud") {
          expect(request).toHaveBeenCalledWith("sessions.dispatch", {
            key: session.key,
            agentId: "main",
            profileId: "aws",
            os: "windows/wsl2",
            machineClass: "fast",
          });
        } else {
          expect(request).toHaveBeenCalledWith(
            "sessions.reclaim",
            {
              key: session.key,
              agentId: "main",
              recoverToGateway: { expectedGeneration: 2 },
            },
            { timeoutMs: null },
          );
          expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
        }
        expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
        expect(refreshReplacement).toHaveBeenCalledWith("main");
      } finally {
        recovery.resolve({ ok: true });
      }
    },
  );
});
