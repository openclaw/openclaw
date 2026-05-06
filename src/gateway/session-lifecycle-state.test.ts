import { describe, expect, it } from "vitest";
import {
  deriveGatewaySessionLifecycleSnapshot,
  derivePersistedSessionLifecyclePatch,
} from "./session-lifecycle-state.js";

describe("session lifecycle state", () => {
  it("reactivates completed sessions on lifecycle start", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 500,
          status: "done",
          startedAt: 100,
          endedAt: 400,
          runtimeMs: 300,
          abortedLastRun: true,
        },
        event: {
          ts: 1_000,
          data: {
            phase: "start",
            startedAt: 900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 900,
      status: "running",
      startedAt: 900,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
      pauseReason: undefined,
    });
  });

  it("marks completed lifecycle end events as done with terminal timing", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_200,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            startedAt: 1_200,
            endedAt: 1_900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_900,
      status: "done",
      startedAt: 1_200,
      endedAt: 1_900,
      runtimeMs: 700,
      abortedLastRun: false,
      pauseReason: undefined,
    });
  });

  it("maps aborted stop reasons to killed", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_800,
            stopReason: "aborted",
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_800,
      status: "killed",
      startedAt: 1_100,
      endedAt: 1_800,
      runtimeMs: 700,
      abortedLastRun: true,
      pauseReason: undefined,
    });
  });

  it("maps aborted lifecycle end events without stopReason to timeout", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_550,
            aborted: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
      pauseReason: undefined,
    });
  });

  it("marks yielded lifecycle end events as paused with sessions_yield reason", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_800,
            stopReason: "end_turn",
            yielded: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_800,
      status: "paused",
      startedAt: 1_100,
      endedAt: 1_800,
      runtimeMs: 700,
      abortedLastRun: false,
      pauseReason: "sessions_yield",
    });
  });

  it("treats yielded as paused even when aborted is set", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_500,
            aborted: true,
            yielded: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_500,
      status: "paused",
      startedAt: 1_100,
      endedAt: 1_500,
      runtimeMs: 400,
      abortedLastRun: false,
      pauseReason: "sessions_yield",
    });
  });

  it("does not leak sessions_yield onto error end events even when yielded is set", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "error",
            endedAt: 1_700,
            yielded: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_700,
      status: "failed",
      startedAt: 1_100,
      endedAt: 1_700,
      runtimeMs: 600,
      abortedLastRun: false,
      pauseReason: undefined,
    });
  });

  it("clears pauseReason when a fresh run starts on a paused session", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_500,
          status: "paused",
          startedAt: 1_100,
          endedAt: 1_500,
          runtimeMs: 400,
          abortedLastRun: false,
          pauseReason: "sessions_yield",
        },
        event: {
          ts: 2_000,
          data: {
            phase: "start",
            startedAt: 1_900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_900,
      status: "running",
      startedAt: 1_900,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
      pauseReason: undefined,
    });
  });
});
