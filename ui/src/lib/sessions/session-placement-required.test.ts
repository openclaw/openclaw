import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { sessionRequest } from "./hydration-family.test-support.ts";
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
const methods = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map(([method]) => method);
const start = (
  request: ReturnType<typeof vi.fn>,
  mode: Parameters<typeof startSessionPlacementInitialTurn>[1]["mode"] = params.mode,
  current = () => true,
) => startSessionPlacementInitialTurn(clientWith(request), { ...params, mode }, current);
function placementRequest(read: () => unknown) {
  return sessionRequest({
    "agents.list": () => catalog,
    "sessions.describe": read,
    "chat.send": () => ({ runId: "first-turn", status: "started" }),
    "sessions.reclaim": () => ({}),
  });
}
function restore(overrides: Partial<SessionPlacementRecovery> = {}) {
  const { key: sessionKey, mode: _mode, ...draft } = params;
  const recovery: SessionPlacementRecovery = {
    ...draft,
    sessionKey,
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal",
    phase: "sending",
    ...overrides,
  };
  expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  return readSessionPlacementRecovery(recovery.gatewayUrl, recovery.recoveryScope, sessionKey)!;
}
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});

it("waits for server-started placement and sends exactly once without dispatch", async () => {
  vi.useFakeTimers();
  let state = "provisioning";
  const request = placementRequest(() => ({ session: { placement: { state } } }));
  const pending = start(request);
  await vi.advanceTimersByTimeAsync(0);
  expect(methods(request)).toEqual(["agents.list", "sessions.describe"]);
  state = "active";
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toEqual({ status: "started", messageId: "first-turn" });
  expect(methods(request)).toEqual([
    "agents.list",
    "sessions.describe",
    "sessions.describe",
    "chat.send",
  ]);
});

it.each(["failed", "reclaimed", "local"])(
  "admits explicit Retry from %s through the server run owner, not admin dispatch",
  async (state) => {
    const request = placementRequest(() => ({ session: { placement: { state } } }));
    expect(await start(request, "retry")).toEqual({ status: "started", messageId: "first-turn" });
    expect(methods(request)).toEqual(["agents.list", "sessions.describe", "chat.send"]);
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
    expect(await start(request)).toMatchObject({ status: "dispatch-rejected" });
    expect(request.mock.calls).toHaveLength(1);
  },
);

it("Stop fences a late active placement reply and retains the existing reclaim owner", async () => {
  const active = createDeferred<unknown>();
  const read = createDeferred();
  let current = true;
  const request = placementRequest(() => {
    read.resolve();
    return active.promise;
  });
  const pending = start(request, "dispatch", () => current);
  await read.promise;
  current = false;
  active.resolve({ session: { placement: { state: "active" } } });
  expect(await pending).toEqual({ status: "cancelled" });
  expect(methods(request)).toEqual(["agents.list", "sessions.describe", "sessions.reclaim"]);
});

it("restores a required first input by resending its original key without placement changes", async () => {
  const restored = restore();
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
  expect(methods(request)).toEqual(["chat.send"]);
  expect(request).toHaveBeenCalledWith(
    "chat.send",
    expect.objectContaining({ idempotencyKey: params.messageId, message: params.message }),
    expect.anything(),
  );
});

it("retains an explicit native runtime while a required create is restored", () => {
  const createParams = {
    key: params.key,
    agentId: params.agentId,
    message: "",
    model: "openai/available-model",
    agentRuntime: "openclaw" as const,
    worktree: true,
    worktreeSource: "empty" as const,
  };
  expect(
    restore({
      phase: "creating",
      sessionId: undefined,
      createParams,
    }).createParams,
  ).toEqual(createParams);
});
