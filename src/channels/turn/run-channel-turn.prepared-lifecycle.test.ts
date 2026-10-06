import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasFinalChannelTurnDispatch } from "./dispatch-result.js";
import {
  createCtx,
  createRecordInboundSession,
  expectDispatched,
} from "./run-channel-turn.delivery.test-helpers.js";
import { runChannelTurn } from "./run-channel-turn.js";
import type { PreparedChannelTurn, RunChannelTurnParams } from "./types.js";

type PreparedTurn = PreparedChannelTurn & {
  runDispatchLifecycle: NonNullable<PreparedChannelTurn["runDispatchLifecycle"]>;
};

describe("prepared channel turn lifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;
  beforeEach(() => {
    storePath = path.join(
      tempDirs.make("openclaw-channel-turn-prepared-lifecycle-"),
      "sessions.json",
    );
  });

  function createTurn(): PreparedTurn {
    return {
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      storePath,
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(),
      runDispatch: vi.fn(async () => ({
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      })),
      runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped: vi.fn() },
    };
  }
  function run(
    turn: PreparedTurn,
    options: {
      turnAdoptionLifecycle?: RunChannelTurnParams<unknown>["turnAdoptionLifecycle"];
      observeOnly?: boolean;
      onFinalize?: RunChannelTurnParams<unknown>["adapter"]["onFinalize"];
    } = {},
  ) {
    return runChannelTurn({
      channel: "test",
      raw: {},
      turnAdoptionLifecycle: options.turnAdoptionLifecycle,
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        preflight: () =>
          options.observeOnly ? { kind: "observeOnly", reason: "broadcast-observer" } : undefined,
        resolveTurn: () => turn,
        onFinalize: options.onFinalize,
      },
    });
  }

  it.each([
    { missing: true, message: "prepared turns must declare runDispatchLifecycle" },
    {
      missing: false,
      message: "runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
    },
  ])(
    "rejects unowned durable ingress adoption (missing lifecycle: $missing)",
    async ({ missing, message }) => {
      const turn = createTurn();
      if (missing) {
        Object.defineProperty(turn, "runDispatchLifecycle", { value: undefined });
      }
      const onFinalize = vi.fn();
      await expect(
        run(turn, {
          turnAdoptionLifecycle: { onAdopted: vi.fn(async () => undefined) },
          onFinalize,
        }),
      ).rejects.toThrow(message);
      expect(turn.recordInboundSession).not.toHaveBeenCalled();
      expect(turn.runDispatch).not.toHaveBeenCalled();
      expect(onFinalize).toHaveBeenCalledWith(
        expect.objectContaining({
          admission: { kind: "dispatch" },
          dispatched: false,
        }),
      );
    },
  );

  it("records before running the prepared dispatch that owns adoption", async () => {
    const events: string[] = [];
    const turn = createTurn();
    const onAdopted = vi.fn(async () => {
      events.push("adopted");
    });
    const turnAdoptionLifecycle = { onAdopted };
    turn.recordInboundSession = createRecordInboundSession(events);
    turn.runDispatchLifecycle = { turnAdoptionLifecycle, onDispatchSkipped: vi.fn() };
    turn.runDispatch = vi.fn(async () => {
      events.push("dispatch");
      await onAdopted();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    const result = await run(turn, { turnAdoptionLifecycle });
    expectDispatched(result);
    expect(result.dispatchResult.queuedFinal).toBe(true);
    expect(events).toEqual(["record", "dispatch", "adopted"]);
    expect(onAdopted).toHaveBeenCalledOnce();
  });

  it("settles prepared resources when observe-only suppresses dispatch", async () => {
    const events: string[] = [];
    const turn = createTurn();
    const onFinalize = vi.fn();
    let resourceOpen = true;
    const onDispatchSkipped = vi.fn(async () => {
      resourceOpen = false;
      events.push("cleanup");
    });
    turn.recordInboundSession = createRecordInboundSession(events);
    turn.runDispatchLifecycle = { turnAdoptionLifecycle: undefined, onDispatchSkipped };
    const observed = { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    turn.observeOnlyDispatchResult = observed;
    const result = await run(turn, { observeOnly: true, onFinalize });
    expectDispatched(result);
    expect(result.dispatchResult).toBe(observed);
    expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
    expect(events).toEqual(["record", "cleanup"]);
    expect(turn.runDispatch).not.toHaveBeenCalled();
    expect(onDispatchSkipped).toHaveBeenCalledWith("observeOnly");
    expect(resourceOpen).toBe(false);
    expect(hasFinalChannelTurnDispatch(result.dispatchResult)).toBe(false);
    expect(onFinalize).toHaveBeenCalledExactlyOnceWith(result);
  });
});
