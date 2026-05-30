import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    });
  });

  it("keeps provider hard timeouts stronger than rpc cancellation metadata", () => {
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
            aborted: true,
            stopReason: "rpc",
            timeoutPhase: "provider",
            providerStarted: true,
            endedAt: 1_550,
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
    });
  });

  it("maps non-hard rpc lifecycle aborts to killed sessions", () => {
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
            aborted: true,
            stopReason: "rpc",
            timeoutPhase: "queue",
            providerStarted: false,
            endedAt: 1_550,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "killed",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: true,
    });
  });

  it("maps provider timeout lifecycle errors to timed out sessions", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "error",
            error: "provider request timed out",
            livenessState: "blocked",
            timeoutPhase: "provider",
            providerStarted: true,
            endedAt: 1_550,
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
    });
  });

  it("maps provider timeout lifecycle end metadata to timed out sessions", () => {
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
            timeoutPhase: "provider",
            providerStarted: true,
            endedAt: 1_550,
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
    });
  });

  it("keeps internal webchat sessions done when a successful assistant turn was persisted before a late error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-webchat-"));
    try {
      const sessionFile = path.join(dir, "session.jsonl");
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "hello" }],
              timestamp: 1_200,
            },
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              stopReason: "stop",
              timestamp: 1_500,
            },
          }),
        ].join("\n") + "\n",
      );

      expect(
        derivePersistedSessionLifecyclePatch({
          storePath: path.join(dir, "sessions.json"),
          entry: {
            sessionId: "session",
            sessionFile,
            route: { channel: "webchat" },
            updatedAt: 1_000,
            startedAt: 1_100,
            status: "running",
            abortedLastRun: true,
          },
          event: {
            ts: 2_000,
            data: {
              phase: "error",
              startedAt: 1_100,
              endedAt: 1_900,
              error: "late abort after assistant persisted",
            },
          },
        }),
      ).toEqual({
        updatedAt: 1_900,
        status: "done",
        startedAt: 1_100,
        endedAt: 1_900,
        runtimeMs: 800,
        abortedLastRun: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not recover external sessions from stale internal channel fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-external-route-"));
    try {
      const sessionFile = path.join(dir, "session.jsonl");
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: "posted externally",
              stopReason: "stop",
              timestamp: 1_500,
            },
          }),
        ].join("\n") + "\n",
      );

      expect(
        derivePersistedSessionLifecyclePatch({
          storePath: path.join(dir, "sessions.json"),
          entry: {
            sessionId: "session",
            sessionFile,
            channel: "webchat",
            lastChannel: "webchat",
            route: { channel: "slack" },
            updatedAt: 1_000,
            startedAt: 1_100,
            status: "running",
            abortedLastRun: true,
          },
          event: {
            ts: 2_000,
            data: {
              phase: "error",
              startedAt: 1_100,
              endedAt: 1_900,
              error: "external delivery failed",
            },
          },
        }),
      ).toMatchObject({
        status: "failed",
        abortedLastRun: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps internal webchat sessions done when persisted assistant content is a string", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-string-webchat-"));
    try {
      const sessionFile = path.join(dir, "session.jsonl");
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: "hi",
              stopReason: "stop",
              timestamp: 1_500,
            },
          }),
        ].join("\n") + "\n",
      );

      expect(
        derivePersistedSessionLifecyclePatch({
          storePath: path.join(dir, "sessions.json"),
          entry: {
            sessionId: "session",
            sessionFile,
            route: { channel: "webchat" },
            updatedAt: 1_000,
            startedAt: 1_100,
            status: "running",
            abortedLastRun: true,
          },
          event: {
            ts: 2_000,
            data: {
              phase: "error",
              startedAt: 1_100,
              endedAt: 1_900,
              error: "late abort after assistant persisted",
            },
          },
        }),
      ).toEqual({
        updatedAt: 1_900,
        status: "done",
        startedAt: 1_100,
        endedAt: 1_900,
        runtimeMs: 800,
        abortedLastRun: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mark aborted partial assistant output as a successful run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-abort-webchat-"));
    try {
      const sessionFile = path.join(dir, "session.jsonl");
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "partial reply" }],
              stopReason: "stop",
              timestamp: 1_500,
              openclawAbort: {
                aborted: true,
                origin: "rpc",
                runId: "run-aborted",
              },
            },
          }),
        ].join("\n") + "\n",
      );

      expect(
        derivePersistedSessionLifecyclePatch({
          storePath: path.join(dir, "sessions.json"),
          entry: {
            sessionId: "session",
            sessionFile,
            route: { channel: "webchat" },
            updatedAt: 1_000,
            startedAt: 1_100,
            status: "running",
            abortedLastRun: false,
          },
          event: {
            ts: 1_800,
            data: {
              phase: "end",
              startedAt: 1_100,
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
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not recover failed internal runs from prior assistant output without current event start proof", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-no-start-webchat-"));
    try {
      const sessionFile = path.join(dir, "session.jsonl");
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "previous turn" }],
              stopReason: "stop",
              timestamp: 1_500,
            },
          }),
        ].join("\n") + "\n",
      );

      expect(
        derivePersistedSessionLifecyclePatch({
          storePath: path.join(dir, "sessions.json"),
          entry: {
            sessionId: "session",
            sessionFile,
            route: { channel: "webchat" },
            updatedAt: 2_000,
            startedAt: 1_100,
            status: "running",
            abortedLastRun: true,
          },
          event: {
            ts: 2_300,
            data: {
              phase: "error",
              endedAt: 2_250,
              error: "new turn failed before assistant content",
            },
          },
        }),
      ).toEqual({
        updatedAt: 2_250,
        status: "failed",
        startedAt: 1_100,
        endedAt: 2_250,
        runtimeMs: 1_150,
        abortedLastRun: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mark failed internal runs done from stale untimestamped assistant history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-stale-webchat-"));
    try {
      const sessionFile = path.join(dir, "session.jsonl");
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({
            type: "message",
            timestamp: 900,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "old success" }],
              stopReason: "stop",
            },
          }),
        ].join("\n") + "\n",
      );

      expect(
        derivePersistedSessionLifecyclePatch({
          storePath: path.join(dir, "sessions.json"),
          entry: {
            sessionId: "session",
            sessionFile,
            route: { channel: "webchat" },
            updatedAt: 1_000,
            startedAt: 1_100,
            status: "running",
            abortedLastRun: true,
          },
          event: {
            ts: 1_300,
            data: {
              phase: "error",
              startedAt: 1_100,
              endedAt: 1_250,
              error: "failed before new assistant content",
            },
          },
        }),
      ).toEqual({
        updatedAt: 1_250,
        status: "failed",
        startedAt: 1_100,
        endedAt: 1_250,
        runtimeMs: 150,
        abortedLastRun: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
