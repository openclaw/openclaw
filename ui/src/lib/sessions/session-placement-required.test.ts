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
  requiredProfile: target.profileId,
  profiles: [{ id: target.profileId }],
  environments: [],
};
const params = {
  key: "agent:main:required",
  agentId: "main",
  target,
  message: "Inspect workspace",
  messageId: "first-turn",
  mode: "dispatch" as const,
};
function clientWith(request: ReturnType<typeof vi.fn>): Pick<GatewayBrowserClient, "request"> {
  return { request: request as GatewayBrowserClient["request"] };
}
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});

it("waits for server-started placement and sends exactly once without dispatch", async () => {
  vi.useFakeTimers();
  let state = "provisioning";
  const request = vi.fn(async (method: string) =>
    method === "environments.list"
      ? catalog
      : method === "sessions.describe"
        ? { session: { placement: { state } } }
        : { runId: "first-turn", status: "started" },
  );
  const pending = startSessionPlacementInitialTurn(clientWith(request), params, () => true);
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "environments.list",
    "sessions.describe",
  ]);
  state = "active";
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toEqual({ status: "started", messageId: "first-turn" });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "environments.list",
    "sessions.describe",
    "sessions.describe",
    "sessions.send",
  ]);
});

it.each(["failed", "reclaimed", "local"])(
  "admits explicit Retry from %s through the server run owner, not admin dispatch",
  async (state) => {
    const request = vi.fn(async (method: string) =>
      method === "environments.list"
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
      "environments.list",
      "sessions.describe",
      "sessions.send",
    ]);
  },
);

it.each([undefined, "replacement"])(
  "does not send or dispatch when the required policy changes to %s",
  async (requiredProfile) => {
    const request = vi.fn(async () => ({ ...catalog, requiredProfile }));
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
    if (method === "environments.list") {
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
    "environments.list",
    "sessions.describe",
    "sessions.reclaim",
  ]);
});

it("restores a required target and reconciles uncertain delivery without a duplicate send", async () => {
  const recovery: SessionPlacementRecovery = {
    sessionKey: params.key,
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
  const request = vi.fn(async (_method: string) => ({ messages: [] }));
  const result = await advanceSessionPlacementDraft({
    client: clientWith(request),
    recovery: restored,
    mode: "recover",
    isLifecycleCurrent: () => true,
    ownsRecovery: () => true,
    clearRecovery: vi.fn(),
    setRecoveryPhase: vi.fn(),
    cleanupOnCancellation: () => false,
  });
  expect(result).toMatchObject({ status: "paused", recovery: { reason: "unconfirmed", target } });
  expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
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
