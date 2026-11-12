import { afterEach, describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../../test-helpers/garbage-collection.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { makeMessage } from "../chat-thread.test-support.ts";
import {
  buildCachedChatItems,
  resetChatThreadState,
  retireChatThreadSources,
  setExpansionState,
} from "../chat-thread.ts";
import {
  sessionKey,
  finalAnswer,
  makeTool,
  chatProps,
  chainFor,
  indexFor,
  projectHistory,
  framesOf,
  onlyFrame,
  messagesIn,
} from "./chat-transcript-message-index.test-support.ts";

afterEach(() => resetChatThreadState());

describe("long completed runs", () => {
  function longRun(extra: ReturnType<typeof makeMessage>[] = [], steps = 300, run = 0) {
    const suffix = run === 0 ? "" : `-${run}`;
    const runId = `run-${run + 1}`;
    const offset = run * 10_000;
    return [
      makeMessage(`question${suffix}`, offset + 1, { role: "user", runId }),
      ...Array.from({ length: steps }, (_, index) => [
        makeMessage(`step-${index}${suffix}`, offset + index * 2 + 2, {
          runId,
          phase: "commentary",
          stopReason: "toolUse",
          content: [
            { type: "text", text: `Inspecting file ${index}` },
            {
              type: "toolCall",
              id: `tool-${index}${suffix}`,
              name: "read",
              arguments: { path: `file-${index}.md` },
            },
          ],
        }),
        makeTool(
          `tool-${index}${suffix}`,
          offset + index * 2 + 3,
          runId,
          offset * 10 + index * 20 + 30,
        ),
      ]).flat(),
      ...extra,
      finalAnswer(`long-answer${suffix}`, offset + steps * 2 + 2 + extra.length, { runId }),
    ];
  }

  it("retires fragmented completed projections before replacing the resident window", async () => {
    const paneId = "fragment-retirement";
    const populate = () => {
      const messages = longRun();
      const remaining = [
        makeMessage("retained-question", 1000, { role: "user", runId: "retained-run" }),
        finalAnswer("retained-answer", 1001, { runId: "retained-run" }),
      ];
      const props = chatProps({ paneId, messages: [...messages, ...remaining] });
      const chain = chainFor(buildCachedChatItems(props));
      const expanded = new Map<string, boolean>();
      for (const frame of framesOf(chain)) {
        for (const part of frame.parts) {
          if (part.kind === "work-group") {
            setExpansionState(expanded, part.key, true);
          }
        }
      }
      const index = indexFor(chain, expanded);
      const fragments = index.rows.flatMap((row) =>
        row.kind === "item" && row.item.kind === "agent-run-frame" && row.item.fragment
          ? [row.item]
          : [],
      );
      expect(fragments.length).toBeGreaterThan(1);
      expect(index.rows.some((row) => row.retainDom)).toBe(true);
      expect(index.messageRowKeysById.get("step-0")).not.toBe(
        index.messageRowKeysById.get("step-299"),
      );
      const retainedAnswerRow = index.messageRowKeysById.get("retained-answer");
      expect(retainedAnswerRow).toBeDefined();
      const references = [...messages, ...fragments].map((value) => new WeakRef(value));
      retireChatThreadSources(paneId, messages);
      return {
        references,
        remaining,
        retainedAnswerRow,
        control: new WeakRef({ unowned: true }),
      };
    };
    try {
      const { references, remaining, retainedAnswerRow, control } = populate();
      await collectGarbageForTest();
      expect(control.deref()).toBeUndefined();
      expect(references.filter((reference) => reference.deref() !== undefined)).toEqual([]);
      const next = indexFor(
        chainFor(buildCachedChatItems(chatProps({ paneId, messages: remaining }))),
      );
      expect(next.messageRowKeysById.get("retained-answer")).toBe(retainedAnswerRow);
      expect(next.messageRowKeysById.has("step-0")).toBe(false);
      expect(next.messageRowKeysById.has("step-299")).toBe(false);
    } finally {
      resetChatThreadState(paneId);
    }
  });

  it.each([
    { name: "single run", runs: 1, steps: 99, windowed: false, retained: false },
    { name: "combined runs", runs: 2, steps: 99, windowed: true, retained: false },
    { name: "512-message medium boundary", runs: 1, steps: 255, windowed: true, retained: false },
    { name: "514-message large boundary", runs: 1, steps: 256, windowed: true, retained: true },
  ])("$name preserves window and preparation policy", ({ runs, steps, windowed, retained }) => {
    const messages = Array.from({ length: runs }, (_, run) => longRun([], steps, run)).flat();
    const chain = projectHistory(messages, { sessionKey: "agent:main:telegram:direct:42" });
    const frames = framesOf(chain);
    expect(frames).toHaveLength(runs);
    const index = indexFor(chain);
    const preparation = { retainDom: windowed, prewarm: windowed && !retained };
    for (const [run, frame] of frames.entries()) {
      const suffix = run === 0 ? "" : `-${run}`;
      const first = index.messageRowKeysById.get(`step-0${suffix}`);
      const last = index.messageRowKeysById.get(`step-${steps - 1}${suffix}`);
      expect(first === frame.key).toBe(!windowed);
      expect(first === last).toBe(!windowed);
      expect(index.messageRowKeysById.get(`long-answer${suffix}`)).toBe(frame.key);
      expect(index.rows.find((row) => row.key === first)).toMatchObject(preparation);
    }
  });

  it.each([sessionKey, "agent:main:telegram:direct:42"])(
    "windows completed work and maps distant replies to their own row in %s",
    (key) => {
      const chain = projectHistory(longRun(), { sessionKey: key });
      const frame = onlyFrame(chain);
      const expanded = new Map<string, boolean>();
      for (const part of frame.parts) {
        if (part.kind === "work-group") {
          setExpansionState(expanded, part.key, true);
        }
      }
      const index = indexFor(chain, expanded);
      const rows = index.rows.filter((row) => row.kind === "item");
      const workRows = rows.filter((row) => row.item.kind === "agent-run-frame");
      expect(workRows.length).toBeGreaterThan(1);
      for (const row of workRows) {
        if (row.item.kind !== "agent-run-frame" || !row.item.fragment) {
          continue;
        }
        // Edge chrome reads the source run, so only independent middle rows
        // may restore geometry keyed solely by their own fragment content.
        if (row.item.fragment.first || row.item.fragment.last) {
          expect(row.revision).toBeUndefined();
        } else {
          expect(row.revision).toBeDefined();
        }
      }
      expect(index.messageRowKeysById.get("step-0")).not.toBe(
        index.messageRowKeysById.get("step-299"),
      );
      expect(index.messageRowKeysById.get("long-answer")).toBe(frame.key);
      expect(rows.at(-1)?.key).toBe(frame.key);
      for (const row of workRows) {
        const parts = row.item.kind === "agent-run-frame" ? row.item.parts : [];
        const content = parts.filter((part) => part.kind !== "work-group");
        expect(
          chatItemGroups({ ...frame, parts: content }).reduce(
            (count, group) => count + group.messages.length,
            0,
          ),
        ).toBeLessThanOrEqual(1);
      }
      const summary = rows.find(
        (row) => row.item.kind === "agent-run-frame" && row.item.parts[0]?.kind === "work-group",
      );
      if (summary) {
        const collapsed = indexFor(chain);
        expect(collapsed.rows.some((row) => row.key === summary.key)).toBe(true);
      }
    },
  );

  it.each([400, 512, 514])("keeps ordered message coverage in %i-message fragments", (count) => {
    const messages = [
      makeMessage("question", 1, { role: "user", runId: "run-1" }),
      ...Array.from({ length: count - 2 }, (_, index) =>
        makeMessage(`body-${index}`, index + 2, { runId: "run-1" }),
      ),
      finalAnswer("answer", count, { runId: "run-1" }),
    ];
    const chain = projectHistory(messages, { sessionKey: "agent:main:telegram:direct:42" });
    const index = indexFor(chain);
    const items = index.rows.flatMap((row) => (row.kind === "item" ? [row.item] : []));
    expect(messagesIn(items)).toEqual(messages);
    expect(index.messageRowKeysById.get("answer")).toBe(onlyFrame(chain).key);
    expect(index.messageRowKeysById.get("body-0") === index.messageRowKeysById.get("body-1")).toBe(
      count <= 512,
    );
    for (const item of items) {
      expect(messagesIn([item]).length).toBeLessThanOrEqual(count <= 512 ? 2 : 1);
    }
  });

  it("keeps widget-bearing completed runs in the retained frame", () => {
    const canvas = makeMessage("canvas", 602, {
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "cv_long_run",
            url: "/__openclaw__/canvas/documents/cv_long_run/index.html",
          },
        },
      ],
    });
    const messages = longRun([canvas]);
    const key = "agent:main:telegram:direct:42";
    const activeChain = projectHistory(messages.slice(0, -1), {
      sessionKey: key,
      runWorking: true,
      runId: "run-1",
      activeRunId: "run-1",
      streamStartedAt: 1_000,
    });
    const activeFrame = onlyFrame(activeChain);
    expect(activeFrame.outcome.kind).toBe("active");
    expect(indexFor(activeChain).messageRowKeysById.get("canvas")).toBe(activeFrame.key);
    const chain = projectHistory(messages, {
      sessionKey: key,
    });
    const frame = onlyFrame(chain);
    expect(frame.key).toBe(activeFrame.key);
    expect(
      indexFor(chain).rows.filter((row) => row.kind === "item" && row.item === frame),
    ).toHaveLength(1);
    expect(indexFor(chain).messageRowKeysById.get("canvas")).toBe(frame.key);
  });

  it("retains the answer row when completed work follows the final answer", () => {
    const chain = projectHistory([...longRun(), makeTool("late-tool", 603, "run-1", 6_030)], {
      sessionKey: "agent:main:telegram:direct:42",
    });
    const frame = onlyFrame(chain);
    expect(frame.outcome).toMatchObject({
      kind: "completed",
      actionOwner: { message: { __openclaw: { id: "long-answer" } } },
    });
    expect(indexFor(chain).messageRowKeysById.get("long-answer")).toBe(frame.key);
    expect(
      indexFor(chain)
        .rows.filter((row) => row.kind === "item")
        .map((row) => row.key),
    ).toEqual([chain.transcriptItems[0]!.key, frame.key]);
  });

  it("retains the summary row when completed work has no answer", () => {
    const chain = projectHistory(longRun().slice(0, -1));
    const frame = onlyFrame(chain);
    expect(frame.outcome).toEqual({ kind: "completed", actionOwner: null });
    const collapsed = indexFor(chain);
    const expanded = new Map<string, boolean>();
    for (const part of frame.parts) {
      if (part.kind === "work-group") {
        setExpansionState(expanded, part.key, true);
      }
    }
    expect(indexFor(chain, expanded).rows.map((row) => row.key)).toEqual(
      collapsed.rows.map((row) => row.key),
    );
  });
});
