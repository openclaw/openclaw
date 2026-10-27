// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { SessionsPatchManyParams } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import { sessionRpcHarness, sessionRow } from "./session-rpc.test-support.ts";

it.each([false, true])(
  "serializes overlapping readers, rolls back failures, and publishes explicit errors once (%s)",
  async (publishErrors) => {
    const rows = [sessionRow("first", { unread: true }), sessionRow("second", { unread: true })];
    const firstResponse = createDeferred();
    const started = createDeferred();
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const h = sessionRpcHarness({
      "sessions.list": () => sessionsResult(rows),
      "sessions.subscribe": () => ({ subscribed: true }),
      "sessions.patchMany": async () => {
        peak = Math.max(peak, ++inFlight);
        try {
          if (++calls === 1) {
            started.resolve();
            await firstResponse.promise;
          }
          throw new Error("Synthetic read failure");
        } finally {
          inFlight -= 1;
        }
      },
    });
    h.update({ hello: sessionMutationGatewayHello() });
    await h.sessions.refresh({ force: true });
    const errors = vi.fn();
    let previousError: string | null = null;
    h.sessions.subscribe((state) => {
      if (state.error && state.error !== previousError) {
        errors(state.error);
      }
      previousError = state.error;
    });
    const first = h.sessions.acknowledgeHiddenRuns([rows[0]!], { publishErrors });
    const second = h.sessions.acknowledgeHiddenRuns([rows[1]!]);
    expect(h.sessions.state.result?.sessions.map((row) => row.unread)).toEqual([false, false]);
    await started.promise;
    expect(calls).toBe(1);
    firstResponse.resolve();
    expect((await first)[0]?.ok).toBe(false);
    expect((await second)[0]?.ok).toBe(false);
    expect({ calls, peak }).toEqual({ calls: 2, peak: 1 });
    expect(h.sessions.state.result?.sessions.map((row) => row.unread)).toEqual([true, true]);
    expect(errors).toHaveBeenCalledTimes(publishErrors ? 1 : 0);
    if (publishErrors) {
      expect(errors).toHaveBeenCalledWith("Synthetic read failure");
    }
  },
);

it("settles partial outcomes and conditional no-ops without hiding a newer manual marker", async () => {
  const rows = ["marked", "read", "failed"].map((id) =>
    sessionRow(id, { unread: true, updatedAt: 1 }),
  );
  const reply = createDeferred();
  const started = createDeferred();
  const h = sessionRpcHarness({
    "sessions.list": () => sessionsResult(rows, 100),
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.patchMany": async (raw) => {
      const params = raw as SessionsPatchManyParams;
      expect(params.targets).toEqual(
        rows.map((row) => ({
          key: row.key,
          agentId: "main",
          expectedSessionId: row.sessionId,
          expectedMarkedUnreadAt: null,
        })),
      );
      started.resolve();
      await reply.promise;
      return {
        outcomes: rows.map(({ key }, index) =>
          index === 2
            ? {
                key,
                ok: false,
                error: { code: "UNAVAILABLE", message: "Synthetic target failure" },
              }
            : { key, ok: true },
        ),
      };
    },
  });
  h.update({ hello: sessionMutationGatewayHello() });
  await h.sessions.refresh({ force: true });
  const operation = h.sessions.acknowledgeHiddenRuns(rows);
  expect(h.sessions.state.result?.sessions.map((row) => row.unread)).toEqual([false, false, false]);
  await started.promise;
  Object.assign(rows[0]!, { markedUnreadAt: 99, updatedAt: 99, unread: true });
  Object.assign(rows[1]!, { unread: false, lastReadAt: 99 });
  reply.resolve();
  const outcomes = await operation;
  expect(outcomes.map(({ ok }) => ok)).toEqual([true, true, false]);
  expect(h.sessions.state.result?.sessions.map((row) => row.unread)).toEqual([true, false, true]);
  expect(h.sessions.state.result?.sessions[0]).toMatchObject({ unread: true, markedUnreadAt: 99 });
  expect(h.sessions.state.error).toBeNull();
});

it("rechecks access after a chunk and skips viewers and manual unread markers", async () => {
  const rows = Array.from({ length: 151 }, (_, index) =>
    sessionRow(`run-${index}`, { unread: true }),
  );
  rows[0]!.sharingRole = "viewer";
  rows[1]!.markedUnreadAt = 1;
  const h = sessionRpcHarness({
    "sessions.list": () => sessionsResult(rows),
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.patchMany": (raw) => {
      const params = raw as SessionsPatchManyParams;
      expect(params.targets).toHaveLength(98);
      expect(
        params.targets.some((target) => target.key === rows[0]!.key || target.key === rows[1]!.key),
      ).toBe(false);
      h.update({ hello: sessionMutationGatewayHello(["operator.read"]) });
      return { outcomes: params.targets.map(({ key }) => ({ key, ok: true })) };
    },
  });
  h.update({ hello: sessionMutationGatewayHello() });
  await h.sessions.refresh({ force: true });
  await h.sessions.acknowledgeHiddenRuns(rows);
  expect(h.request.mock.calls.filter(([method]) => method === "sessions.patchMany")).toHaveLength(
    1,
  );
  expect(h.sessions.state.result?.sessions[0]?.unread).toBe(true);
  expect(h.sessions.state.result?.sessions[1]?.unread).toBe(true);
});

it("keeps a committed read retryable when its reconciliation fails", async () => {
  const row = sessionRow("refresh-failed", { unread: true });
  let failRead = false;
  const h = sessionRpcHarness({
    "sessions.list": () => {
      if (failRead) {
        throw new Error("Synthetic list failure");
      }
      return sessionsResult([row]);
    },
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.patchMany": () => {
      failRead = true;
      return { outcomes: [{ key: row.key, ok: true }] };
    },
  });
  h.update({ hello: sessionMutationGatewayHello() });
  await h.sessions.refresh({ force: true });
  const [outcome] = await h.sessions.acknowledgeHiddenRuns([row]);
  expect(outcome?.ok).toBe(false);
  expect(outcome?.error).toBeInstanceOf(Error);
  expect(h.sessions.state.result?.sessions[0]?.unread).toBe(true);
  expect(h.sessions.state.error).toBeNull();
});
