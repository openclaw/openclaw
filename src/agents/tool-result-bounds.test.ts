import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-output.js";
import { buildExecForegroundResult } from "./bash-tools.exec-support.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import type { AgentToolResult } from "./runtime/index.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { boundSessionToolResult } from "./sessions/session-tool-result-preparation.js";
import { createReadTool } from "./sessions/tools/read.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const spills: string[] = [];
afterEach(async () => {
  await Promise.all(spills.splice(0).map((path) => fs.rm(path, { force: true })));
});

// Plain log lines: nothing in the tail looks like an error or a summary.
const full = [
  ...Array.from({ length: 6_000 }, (_, i) => `row ${String(i).padStart(6, "0")} payload abc`),
  "LAST-ROW",
].join("\n");

function guarded() {
  return guardSessionManager(SessionManager.inMemory(), { contextWindowTokens: 200_000 });
}

function text(result: { content: unknown[] }): string {
  return result.content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function spillPath(result: AgentToolResult<unknown>): string | undefined {
  const spill = isRecord(result.details) ? result.details.spill : undefined;
  const path = isRecord(spill) && typeof spill.path === "string" ? spill.path : undefined;
  if (path) {
    spills.push(path);
  }
  return path;
}

/** Records the bounded result the way a turn does and returns the stored text. */
function record(sm: SessionManager, name: string, result: AgentToolResult<unknown>) {
  sm.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "c1", name, arguments: {} }],
      stopReason: "toolUse",
    }),
  );
  sm.appendMessage({ ...makeTextToolResult("c1", name, "", false, 1), ...result } as never);
  const stored = sm
    .getEntries()
    .flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []));
  return text(stored[0]!);
}

describe("tool-result bounds", () => {
  it.each([
    ["exec", () => buildExecForegroundResult({ outcome: completed(full), session: session(full) })],
    [
      "world__list_tickets",
      () => projectMcpCallToolResult({ content: [{ type: "text", text: full }] }),
    ],
    ["plugin_report", () => ({ content: [{ type: "text" as const, text: full }], details: {} })],
  ])(
    "%s keeps head and tail, spills the full output, and records it unchanged",
    async (name, make) => {
      const sm = guarded();
      const raw = make() as AgentToolResult<unknown>;
      const bounded = await boundSessionToolResult(sm, raw);
      const path = spillPath(bounded);
      const boundedText = text(bounded);

      expect(boundedText.length).toBeLessThanOrEqual(64_000);
      expect(boundedText).toContain("row 000000");
      expect(boundedText).toMatch(/LAST-ROW\S*$/u);
      expect(boundedText).toContain(`Full output: ${path}`);
      expect(boundedText).not.toContain("rerun");
      expect(await fs.readFile(path!, "utf8")).toContain(full);
      // Fixed point: the transcript cap stores exactly the bytes the model saw.
      expect(record(sm, name, bounded)).toBe(boundedText);
    },
  );

  it("web_fetch reuses its own spill file instead of writing a second one", async () => {
    const producerFile = `${tempDirs.make("openclaw-web-fetch-")}/page.log`;
    await fs.writeFile(producerFile, full);
    const raw = {
      content: [{ type: "text" as const, text: full }],
      details: { spill: { path: producerFile, chars: full.length } },
    };

    const bounded = await boundSessionToolResult(guarded(), raw);

    expect(bounded.details).toBe(raw.details);
    expect(text(bounded)).toContain(`Full output: ${producerFile}`);
  });

  it("read reaches the middle of a one-line spill, one in-budget page at a time", async () => {
    const line = `${"a".repeat(90_000)}MIDDLE-MARKER${"z".repeat(90_000)}`;
    const sm = guarded();
    const path = spillPath(
      await boundSessionToolResult(sm, { content: [{ type: "text", text: line }], details: {} }),
    )!;
    const read = createOpenClawReadTool(createReadTool(tempDirs.make("openclaw-read-")));

    let args: Record<string, unknown> = { path };
    let found = false;
    for (let page = 0; page < 20 && !found; page += 1) {
      const output = await read.execute(`read-${page}`, args);
      // A page never needs a second spill.
      expect(await boundSessionToolResult(sm, output)).toBe(output);
      const pageText = text(output);
      found = pageText.includes("MIDDLE-MARKER");
      const next = /offset=(\d+)(?:, cursor=(\d+))?/u.exec(pageText);
      args = { path, offset: Number(next?.[1]), ...(next?.[2] ? { cursor: Number(next[2]) } : {}) };
    }
    expect(found).toBe(true);
  });

  it("falls back to the transcript cap without a path when the spill write fails", async () => {
    const sm = guarded();
    const raw = { content: [{ type: "text" as const, text: full }], details: {} };

    const bounded = await boundSessionToolResult(sm, raw, { sandbox: {} });
    const stored = record(sm, "plugin_report", bounded);

    expect(bounded).toBe(raw);
    expect(stored.length).toBeLessThanOrEqual(64_000);
    expect(stored).toMatch(/LAST-ROW$/u);
    expect(stored).toMatch(/\[\.\.\. \d+ chars omitted\]/u);
    expect(stored).not.toContain("Full output:");
  });
});

function completed(aggregated: string): ExecProcessOutcome {
  return {
    status: "completed",
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    aggregated,
    timedOut: false,
  };
}

function session(output: string) {
  return { totalOutputChars: output.length, output: { length: output.length } };
}
