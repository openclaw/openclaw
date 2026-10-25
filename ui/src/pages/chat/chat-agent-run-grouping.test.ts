import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { message as chatMessage } from "./chat-thread-fixtures.test-support.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import type {
  ActivityRunRenderItem,
  StreamRunRenderItem,
  WorkGroupRenderItem,
} from "./chat-turn-presentation.ts";

function group(
  role: "assistant" | "tool" | "user",
  key: string,
  runId: string | undefined,
  overrides: Record<string, unknown> = {},
): MessageGroup {
  const entry = chatMessage(role === "tool" ? "toolResult" : role, key, 1, overrides);
  const [prepared] = groupMessages([{ kind: "message", key, message: entry }], {}, undefined, true);
  if (prepared?.kind !== "group") {
    throw new Error("expected a prepared message group");
  }
  return {
    kind: "group",
    key: `group:${key}`,
    role,
    visibleContent: "text",
    messages: prepared.messages,
    timestamp: 1,
    isStreaming: false,
    ...(runId ? { runId } : {}),
  };
}

function userBoundary(sendId = "send-1"): MessageGroup {
  return group("user", `user:${sendId}`, undefined, {
    __openclaw: { id: `user:${sendId}`, idempotencyKey: `${sendId}:user` },
  });
}

function streamRun(
  runId: string,
  boundaryId: string,
  partKey: string,
  text?: string,
  key = `stream-run:${partKey}`,
  startedAt = 1,
): StreamRunRenderItem {
  const common = { key: partKey, startedAt, runId, boundaryId };
  return {
    kind: "stream-run",
    key,
    runId,
    boundaryId,
    parts: [
      text === undefined
        ? { kind: "reading-indicator", ...common }
        : { kind: "stream", ...common, text, isStreaming: true },
    ],
  };
}

const assistant = (key: string, overrides: Record<string, unknown>) =>
  group("assistant", key, "run-1", overrides);
const toolGroup = (key: string) => group("tool", key, "run-1");
const completed = (name: string, parts: MessageGroup[], actionKey: string | null = null) => ({
  name,
  parts,
  outcome: { kind: "completed", actionOwner: actionKey === null ? null : { key: actionKey } },
});

type AgentRunFrameRenderItem = Extract<
  ReturnType<typeof coalesceAgentRunFrames>[number],
  { kind: "agent-run-frame" }
>;

function requireFrame(
  value: ReturnType<typeof coalesceAgentRunFrames>[number] | undefined,
): AgentRunFrameRenderItem {
  if (value?.kind !== "agent-run-frame") {
    throw new Error("expected an agent run frame");
  }
  return value;
}

describe("coalesceAgentRunFrames", () => {
  it.each(["interrupted", "silent-terminal"] as const)(
    "classifies a persisted tool-use tail as %s without inventing a final answer",
    (state) => {
      const runId = "run-tail";
      const commentary = group("assistant", "Checking the fixture.", runId, {
        stopReason: "toolUse",
        __openclaw: { runId, turnTainted: true },
      });
      const terminal = { role: "assistant", stopReason: "stop", content: [], runId };
      const frame = requireFrame(
        coalesceAgentRunFrames(
          [userBoundary(runId), commentary, group("tool", "inspection", runId)],
          {
            messages: [
              ...commentary.messages.map(({ message }) => message),
              ...(state === "silent-terminal" ? [terminal] : []),
            ],
            activeRunId: null,
          },
        )[1],
      );
      expect(frame.outcome).toEqual(
        state === "interrupted" ? { kind: state } : { kind: "completed", actionOwner: null },
      );
      expect(frame.parts).toHaveLength(2);
    },
  );

  it("keeps one lifecycle-stable frame key while preserving semantic part keys", () => {
    const runId = "run-1";
    const stream = streamRun(
      runId,
      "send:send-1",
      "stream:run-1",
      "Working on it.",
      "stream-run:run-1",
    );
    const tool = group("tool", "tool:run-1", runId);
    const activity: ActivityRunRenderItem = {
      kind: "activity-run",
      key: "activity:tool:run-1",
      groups: [tool],
    };
    const final = group("assistant", "assistant:run-1", runId);
    const work: WorkGroupRenderItem = {
      kind: "work-group",
      key: "work:assistant:run-1",
      groups: [tool],
      durationMs: 1,
    };
    const boundary = userBoundary();

    const streaming = requireFrame(coalesceAgentRunFrames([boundary, stream])[1]);
    const tooling = requireFrame(coalesceAgentRunFrames([boundary, stream, activity])[1]);
    const history = requireFrame(coalesceAgentRunFrames([boundary, work, final])[1]);

    expect(streaming.key).toBe(tooling.key);
    expect(tooling.key).toBe(history.key);
    expect(history.key).toContain(JSON.stringify([runId, "send:send-1"]));
    expect(tooling.parts.map((part) => part.key)).toEqual([stream.key, activity.key]);
    expect(history.parts.map((part) => part.key)).toEqual([work.key, final.key]);
  });

  it("keeps the live send frame identity when a hidden boundary materializes in history", () => {
    const runId = "run-heartbeat-handoff";
    const stream = streamRun(
      runId,
      `send:${runId}`,
      "reading:heartbeat-handoff",
      undefined,
      "stream-run:heartbeat-handoff",
    );
    const live = requireFrame(coalesceAgentRunFrames([userBoundary(runId), stream])[1]);
    const persistedBoundary = group("assistant", "persisted-after-heartbeat", runId, {
      api: "cli",
      idempotencyKey: `cli-assistant:${runId}`,
      __openclaw: {
        id: "persisted-after-heartbeat",
        turnBoundary: true,
      },
    });
    const history = requireFrame(coalesceAgentRunFrames([persistedBoundary])[0]);

    expect(history.boundaryId).toBe(`send:${runId}`);
    expect(history.key).toBe(live.key);
  });

  it("keeps a restart-recovered tool-only run in one stable frame", () => {
    const runId = "run-recovered";
    const boundaryId = `send:${runId}`;
    const recoveryNotice = {
      kind: "notice" as const,
      key: "notice:restart-recovery",
      text: "Turn interrupted by a gateway restart.",
      timestamp: 1,
      startsTurn: true as const,
      boundaryId,
    };
    const first = group("tool", "recovered-tool-1", runId);
    const second = group("tool", "recovered-tool-2", runId);
    const historyActivity: ActivityRunRenderItem = {
      kind: "activity-run",
      key: "activity:recovered-tools",
      groups: [first, second],
    };

    const live = requireFrame(coalesceAgentRunFrames([recoveryNotice, first, second])[1]);
    const history = requireFrame(coalesceAgentRunFrames([recoveryNotice, historyActivity])[1]);

    expect(live.parts).toEqual([first, second]);
    expect(history.parts).toEqual([historyActivity]);
    expect(live.boundaryId).toBe(boundaryId);
    expect(history.key).toBe(live.key);
  });

  it("remounts a large live stream after steer without destabilizing ordinary frames", () => {
    const runId = "run-steered";
    const boundaryId = "send:steer-run";
    const working = streamRun(runId, boundaryId, "working");
    const streamed = streamRun(
      runId,
      boundaryId,
      "working:after:steer-run",
      "Large terminal response",
      "stream-run:stream-after-steer",
      2,
    );

    expect(
      requireFrame(coalesceAgentRunFrames([userBoundary("steer-run"), working])[1]).key,
    ).not.toBe(requireFrame(coalesceAgentRunFrames([userBoundary("steer-run"), streamed])[1]).key);
  });

  it.each([
    {
      name: "forwarded sessions_send input",
      boundary: group("assistant", "forwarded", "run-1", {
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
    },
  ])("does not compose across $name", ({ boundary }) => {
    const items = coalesceAgentRunFrames([
      userBoundary(),
      group("assistant", "before", "run-1"),
      boundary,
      group("assistant", "after", "run-1"),
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "group",
      "agent-run-frame",
      "group",
      "agent-run-frame",
    ]);
    expect(items[2]).toBe(boundary);
    expect(requireFrame(items[1]).parts.map((part) => part.key)).toEqual(["group:before"]);
    expect(requireFrame(items[3]).parts.map((part) => part.key)).toEqual(["group:after"]);
    expect(requireFrame(items[1]).key).not.toBe(requireFrame(items[3]).key);
  });

  it.each([
    {
      name: "notice",
      boundary: { kind: "notice" as const, key: "notice", text: "Notice", timestamp: 2 },
    },
    { name: "metadata-less peer", boundary: group("user", "peer", undefined) },
  ])("gives a restored run segment a unique key after a $name boundary", ({ boundary }) => {
    const runId = "run-1";
    const restoredStream = streamRun(
      runId,
      "send:send-1",
      "reading:restored",
      undefined,
      "stream-run:restored",
      3,
    );
    const items = coalesceAgentRunFrames([
      userBoundary(),
      group("assistant", "before", runId),
      boundary,
      restoredStream,
    ]);
    const frames = items.filter(
      (item): item is AgentRunFrameRenderItem => item.kind === "agent-run-frame",
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]?.key).not.toBe(frames[1]?.key);
    expect(frames[0]?.key).toBe(
      requireFrame(coalesceAgentRunFrames([userBoundary(), group("assistant", "before", runId)])[1])
        .key,
    );
  });

  it.each([
    completed("persisted keyed commentary", [
      assistant("commentary-stop", {
        stopReason: "stop",
        openclawStreamFallback: {
          replacementText: "I will inspect it.",
          source: "segment",
          itemId: "commentary-1",
        },
      }),
      toolGroup("commentary-tool"),
    ]),
    completed(
      "provider speech cannot replace a completed frame answer",
      [
        assistant("backing-answer", { stopReason: "stop" }),
        assistant("spoken-readback", {
          stopReason: "stop",
          __openclaw: { voiceTranscript: "provider-owned" },
        }),
      ],
      "backing-answer",
    ),
    completed("Codex reasoning mirror", [
      assistant("reasoning", {
        stopReason: "stop",
        __openclaw: { mirrorOrigin: "codex-app-server", runId: "run-1" },
      }),
      toolGroup("reasoning-tool"),
    ]),
    completed(
      "attachment-only final followed by work",
      [
        assistant("final-document", {
          phase: "final_answer",
          content: [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                url: "https://files.example.test/report.pdf",
                label: "report.pdf",
                mimeType: "application/pdf",
              },
            },
          ],
        }),
        toolGroup("trailing-tool"),
      ],
      "final-document",
    ),
    completed(
      "image-only final",
      [
        assistant("final-image", {
          stopReason: "stop",
          content: [{ type: "image", url: "https://files.example.test/banner.png" }],
        }),
      ],
      "final-image",
    ),
    completed(
      "omitted-image-only final",
      [
        assistant("final-omitted-image", {
          stopReason: "stop",
          content: [{ type: "image", omitted: true, bytes: 12 * 1024 }],
        }),
      ],
      "final-omitted-image",
    ),
    completed("reasoning-only final", [
      assistant("thinking", {
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "I am considering the request." }],
      }),
    ]),
    completed(
      "mixed-phase answer followed by work",
      [
        assistant("mixed-final", {
          content: ["commentary", "final_answer"].map((phase) => ({
            type: "text",
            text: phase === "commentary" ? "Checking" : "Finished.",
            textSignature: JSON.stringify({ v: 1, id: phase, phase }),
          })),
        }),
        toolGroup("trailing-tool"),
      ],
      "mixed-final",
    ),
  ])("records $name without deriving completion from the last part", ({ parts, outcome }) => {
    const frame = requireFrame(coalesceAgentRunFrames([userBoundary(), ...parts])[1]);

    expect(frame).toMatchObject({ outcome });
  });

  it.each([
    { name: "placement abort", terminal: { stopReason: "stop", openclawAbort: { aborted: true } } },
  ])("marks an interrupted partial failed for $name", ({ terminal }) => {
    const frame = requireFrame(
      coalesceAgentRunFrames([
        userBoundary(),
        group("assistant", "partial", "run-1", { content: "Partial answer", ...terminal }),
      ])[1],
    );

    expect(frame.outcome).toEqual({ kind: "failed" });
  });

  it("does not join promptless tools to a stream with a different explicit boundary", () => {
    const tool = group("tool", "old-tool", "run-1");
    const stream = streamRun(
      "run-1",
      "send:steer",
      "reading:steered",
      undefined,
      "stream:steered",
      2,
    );
    const items = coalesceAgentRunFrames([tool, stream]);
    expect(items[0]).toBe(tool);
    expect(requireFrame(items[1])).toMatchObject({
      boundaryId: "send:steer",
      outcome: { kind: "active" },
      parts: [stream],
    });
  });

  it("leaves active search projections uncomposed", () => {
    const input = [userBoundary(), group("assistant", "match", "run-1")];

    expect(coalesceAgentRunFrames(input, { searchActive: true })).toBe(input);
  });
});
