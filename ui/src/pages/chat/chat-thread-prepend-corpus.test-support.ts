/** Synthetic long-lived sessions for older-history prepend equivalence checks. */

type Message = Record<string, unknown>;

const people = [
  {},
  { senderId: "alice", senderName: "Alice", senderIdentity: { type: "profile", id: "alice" } },
  { senderId: "bob", senderName: "Bob", senderIdentity: { type: "profile", id: "bob" } },
];

const canvas = (id: string) =>
  JSON.stringify({
    kind: "canvas",
    view: { backend: "canvas", id, url: `/__openclaw__/canvas/documents/${id}/index.html` },
    presentation: { target: "assistant_message" },
  });

type CorpusOptions = {
  /** Rotates the turn shapes against page seams. */
  seed?: number;
  /** Every person prompt comes from the signed-in viewer. */
  solo?: boolean;
  /** Display positions, model selections, reply-to-current, failure streaks, heartbeats. */
  edges?: boolean;
  /** One transcript-wide fact the oldest turns share with turns about 20 later. */
  collision?: "id" | "prompt" | "reply" | "canvas" | "model" | "person" | "divider";
};

function turn(index: number, options: CorpusOptions): Message[] {
  const messages = shapedTurn(index, options);
  if (options.collision === "canvas" && (index === 10 || index === 30)) {
    // A redelivered invocation: same run and call, another transcript entry.
    const ts = index * 100 + 99;
    messages.push({
      role: "toolResult",
      toolCallId: "c-redelivered",
      toolName: "canvas_render",
      content: canvas("cv_redelivered"),
      timestamp: ts,
      runId: "run-redelivered",
      __openclaw: { id: `m-${index}-redelivered`, seq: ts, runId: "run-redelivered" },
    });
  }
  return messages;
}

function shapedTurn(index: number, options: CorpusOptions): Message[] {
  const { edges = false, collision } = options;
  const variant = (index * 5 + (options.seed ?? 0)) % 8;
  const runId = `run-${index}`;
  let seq = index * 100;
  const meta = (id: string, extra: object = {}) => {
    seq += 1;
    return {
      id: collision === "id" && index === 26 && id.endsWith("answer") ? `m-6-answer` : id,
      seq,
      ...(edges ? { transcriptPosition: { source: "snapshot", rawSeq: seq } } : {}),
      ...extra,
    };
  };
  const user = (text: string, extra: object = {}): Message => {
    const sender = options.solo
      ? collision === "person" && index === 5
        ? people[2]
        : {}
      : people[index % people.length];
    const selects = collision === "model" ? index < 10 || index === 30 : edges;
    const modelSelection = selects
      ? {
          modelSelection: {
            provider: "openai",
            model: index % 16 < 8 !== (index === 30) ? "gpt-a" : "gpt-b",
          },
        }
      : {};
    const metadata = meta(`m-${index}-user-${seq}`, {
      idempotencyKey: `${runId}:user`,
      ...sender,
      ...modelSelection,
      ...(collision === "prompt" && index === 29 ? { runId: "run-9" } : {}),
    });
    return { role: "user", content: text, timestamp: metadata.seq, __openclaw: metadata, ...extra };
  };
  const reply = (id: string, content: unknown, extra: object = {}): Message => {
    // A late reply to an older run's prompt, after newer prompts.
    const late = collision === "reply" && index === 31 && id === "answer";
    const run = late ? "run-11" : runId;
    const metadata = meta(`m-${index}-${id}`, { runId: run });
    return {
      role: "assistant",
      content,
      timestamp: metadata.seq,
      runId: run,
      __openclaw: metadata,
      ...(late ? { openclawDelivery: { replyToCurrent: true } } : {}),
      ...extra,
    };
  };
  const result = (id: string, callId: string, toolName: string, content: unknown): Message => {
    const metadata = meta(`m-${index}-${id}`, { runId });
    return {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content,
      timestamp: metadata.seq,
      runId,
      __openclaw: metadata,
    };
  };
  const call = (id: string, name: string, args: object = {}) => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });
  switch (variant) {
    case 0:
      return [
        user(`Question ${index} about needle files`),
        reply(
          "answer",
          [
            { type: "thinking", thinking: `Considering ${index}` },
            { type: "text", text: `Answer ${index} with needle` },
          ],
          edges ? { openclawDelivery: { replyToCurrent: true } } : {},
        ),
      ];
    case 1:
      return [
        user(`Read files for ${index}`),
        reply("call-a", [call(`c-${index}-a`, "read", { path: `a-${index}.txt` })], {
          stopReason: "toolUse",
        }),
        result("res-a", `c-${index}-a`, "read", `contents of a ${index}`),
        reply("call-b", [{ type: "text", text: "Checking more." }, call(`c-${index}-b`, "exec")], {
          stopReason: "toolUse",
        }),
        result("res-b", `c-${index}-b`, "exec", [{ type: "text", text: `exit 0 for ${index}` }]),
        reply("answer", `Done reading ${index}`),
      ];
    case 2: {
      const child = `agent:main:subagent:${index}`;
      return [
        user(`Delegate task ${index}`),
        reply("spawn", [call(`c-${index}-spawn`, "sessions_spawn", { task: `child ${index}` })], {
          stopReason: "toolUse",
        }),
        result("spawn-res", `c-${index}-spawn`, "sessions_spawn", {
          status: "accepted",
          childSessionKey: child,
        }),
        reply("yield", [call(`c-${index}-yield`, "sessions_yield")], { stopReason: "toolUse" }),
        result(
          "yield-res",
          `c-${index}-yield`,
          "sessions_yield",
          '{"status":"yielded","acknowledgment":"Waiting on the child."}',
        ),
        user(`Child ${index} finished`, {
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          __openclaw: meta(`m-${index}-child`, {
            senderSession: { sessionKey: child, label: "child" },
          }),
        }),
        reply("resume", `Resumed after child ${index}`),
      ];
    }
    case 3:
      return [
        user(`Draw canvas ${index}`),
        reply("canvas-call", [call(`c-${index}-canvas`, "canvas_render")], {
          stopReason: "toolUse",
        }),
        result("canvas-res", `c-${index}-canvas`, "canvas_render", canvas(`cv_${index}`)),
        reply("canvas-answer", `Canvas ${index} ready`),
      ];
    case 4: {
      const marker = meta(`m-${index}-compaction`, { kind: "compaction" });
      const unkeyed = collision === "divider" && index > 14 && index < 24;
      return [
        {
          role: "system",
          content: "",
          timestamp: marker.seq,
          __openclaw: unkeyed ? { ...marker, id: undefined } : marker,
        },
        user(`After compaction ${index}`),
        reply("answer", `Compacted reply ${index}`),
      ];
    }
    case 5:
      return [
        user(`Model turn ${index}`),
        reply("answer", `Model reply ${index}`),
        ...(edges
          ? [
              reply("failed-a", "", { openclawRunError: { runId, summary: "Rate limited" } }),
              reply("failed-b", "", { openclawRunError: { runId, summary: "Rate limited" } }),
              reply("heartbeat", "HEARTBEAT_OK"),
            ]
          : []),
        {
          role: "system",
          content: `System notice ${index}`,
          timestamp: seq + 1,
          __openclaw: meta(`m-${index}-notice`),
        },
      ];
    case 6:
      return [
        user(`System steer ${index}`, {
          provenance: { kind: "internal_system", sourceTool: "cron" },
        }),
        reply("answer", `Automated reply ${index}`),
      ];
    default:
      return [
        user(`Steer ${index}`),
        user(`Steer again ${index}`),
        reply("answer", `Combined reply ${index}`),
      ];
  }
}

/** Roughly count messages ending at the newest turn. */
export function createPrependCorpus(count: number, options: CorpusOptions = {}): Message[] {
  const messages: Message[] = [];
  for (let index = 0; messages.length < count; index++) {
    messages.push(...turn(index, options));
  }
  return messages.slice(messages.length - count);
}
