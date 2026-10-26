import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
  type SessionPlacementRecovery,
} from "./session-placement-recovery.ts";
import { startSessionPlacementInitialTurn } from "./session-placement-startup.ts";
import { advanceSessionPlacementDraft } from "./session-placement-submit.ts";

const target = { kind: "profile", profileId: "dedicated", required: true } as const;
const catalog = {
  sessionPlacement: { requiredProfile: { id: target.profileId, providerId: "device" } },
};
const params = {
  key: "agent:main:required",
  sessionId: "physical-startup-session",
  agentId: "main",
  target,
  message: "Inspect workspace",
  messageId: "first-turn",
  mode: "dispatch" as const,
};
function clientWith(
  request: ReturnType<typeof vi.fn>,
): Parameters<typeof startSessionPlacementInitialTurn>[0] {
  const client = { request: request as GatewayBrowserClient["request"] };
  return {
    client,
    describe: (requestParams, options) => {
      expect(options?.client).toBe(client);
      return client.request("sessions.describe", requestParams);
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});

it("waits for server-started placement and sends exactly once without dispatch", async () => {
  vi.useFakeTimers();
  let state = "provisioning";
  const request = vi.fn(async (method: string) =>
    method === "agents.list"
      ? catalog
      : method === "sessions.describe"
        ? { session: { placement: { state } } }
        : { runId: "first-turn", status: "started" },
  );
  const pending = startSessionPlacementInitialTurn(clientWith(request), params, () => true);
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "agents.list",
    "sessions.describe",
  ]);
  state = "active";
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toEqual({ status: "started", messageId: "first-turn" });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "agents.list",
    "sessions.describe",
    "sessions.describe",
    "chat.send",
  ]);
});

it.each(["failed", "reclaimed", "local"])(
  "admits explicit Retry from %s through the server run owner, not admin dispatch",
  async (state) => {
    const request = vi.fn(async (method: string) =>
      method === "agents.list"
        ? catalog
        : method === "sessions.describe"
          ? { session: { placement: { state } } }
          : { runId: "first-turn", status: "started" },
    );
    expect(
      await startSessionPlacementInitialTurn(
        clientWith(request),
        { ...params, mode: "retry" },
        () => true,
      ),
    ).toEqual({ status: "started", messageId: "first-turn" });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "agents.list",
      "sessions.describe",
      "chat.send",
    ]);
  },
);

it.each([undefined, "replacement"])(
  "does not send or dispatch when the required policy changes to %s",
  async (requiredProfile) => {
    const request = vi.fn(async () => ({
      sessionPlacement: {
        requiredProfile: requiredProfile
          ? { id: requiredProfile, providerId: "device" }
          : undefined,
      },
    }));
    expect(
      await startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).toMatchObject({ status: "dispatch-rejected" });
    expect(request.mock.calls).toHaveLength(1);
  },
);

it("Stop fences a late active placement reply and retains the existing reclaim owner", async () => {
  const active = createDeferred<unknown>();
  const read = createDeferred();
  let current = true;
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list") {
      return catalog;
    }
    if (method === "sessions.describe") {
      read.resolve();
      return active.promise;
    }
    return {};
  });
  const pending = startSessionPlacementInitialTurn(clientWith(request), params, () => current);
  await read.promise;
  current = false;
  active.resolve({ session: { placement: { state: "active" } } });
  expect(await pending).toEqual({ status: "cancelled" });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "agents.list",
    "sessions.describe",
    "sessions.reclaim",
  ]);
});

it("restores a required first input by resending its original key without placement changes", async () => {
  const recovery: SessionPlacementRecovery = {
    sessionKey: params.key,
    sessionId: params.sessionId,
    agentId: params.agentId,
    target,
    message: params.message,
    messageId: params.messageId,
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal",
    phase: "sending",
  };
  expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  const restored = readSessionPlacementRecovery(
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  )!;
  expect(restored.target).toEqual(target);
  const request = vi.fn(async (_method: string) => ({ runId: params.messageId, status: "ok" }));
  const result = await advanceSessionPlacementDraft({
    ...clientWith(request),
    recovery: restored,
    mode: "recover",
    isLifecycleCurrent: () => true,
    ownsRecovery: () => true,
    clearRecovery: vi.fn(),
    setRecoveryPhase: vi.fn(),
    cleanupOnCancellation: () => false,
  });
  expect(result).toEqual({ status: "started", messageId: params.messageId });
  expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.send"]);
  expect(request).toHaveBeenCalledWith(
    "chat.send",
    expect.objectContaining({ idempotencyKey: params.messageId, message: params.message }),
    expect.anything(),
  );
});

it("retains an explicit native runtime while a required create is restored", () => {
  const recovery: SessionPlacementRecovery = {
    sessionKey: params.key,
    agentId: params.agentId,
    target,
    message: params.message,
    messageId: params.messageId,
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal",
    phase: "creating",
    createParams: {
      key: params.key,
      agentId: params.agentId,
      message: "",
      model: "openai/available-model",
      agentRuntime: "openclaw",
      worktree: true,
      worktreeSource: "empty",
    },
  };
  expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  expect(
    readSessionPlacementRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey)
      ?.createParams,
  ).toEqual(recovery.createParams);
});
