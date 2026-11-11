import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { convertToLlm } from "../sessions/messages.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createSkillInstructionPage } from "../skill-instruction-page.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { resolveToolResultBudget } from "../tool-result-limits.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "../tool-search.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

it.each([50_000, 150_000, 300_000, 2_000])(
  "preserves repeated direct/deferred pages at context %s",
  async (contextWindowTokens) => {
    const content =
      "# Synthetic guide\r\n" +
      '😀中é\\\"\t\r\n'.repeat(contextWindowTokens === 300_000 ? 15_000 : 2400) +
      "END SKILL\n";
    for (const deferred of [false, true]) {
      const location = "/synthetic/guide/SKILL.md";
      const tools = createInstalledSkillTools(
        [
          {
            name: "guide",
            description: "Synthetic pagination guide",
            location,
            source: { filePath: location, readContent: content },
          },
        ],
        resolveToolResultBudget(contextWindowTokens),
      );
      finalizeAgentToolAvailability(tools);
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({ catalogRef, tools });
      const tool = expectDefined(
        (deferred ? createToolSearchTools({ catalogRef }) : tools).find(
          (entry) => entry.name === (deferred ? "dispatch_action" : "skills_read"),
        ),
        "reader",
      );
      let cursor: string | undefined;
      let reconstructed = "";
      do {
        const input = { name: "guide", ...(cursor ? { cursor } : {}) };
        const args = deferred ? { id: "skills_read", args: input } : input;
        const produced = await tool.execute("skill-read", args);
        const session = guardSessionManager(SessionManager.inMemory(), { contextWindowTokens });
        await session.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: "skill-read", name: tool.name, arguments: args }],
            stopReason: "toolUse",
          }),
        );
        await session.appendMessageAsync({
          role: "toolResult",
          toolCallId: "skill-read",
          toolName: tool.name,
          ...produced,
          isError: false,
          timestamp: 1,
        });
        const delivered = convertToLlm(session.buildSessionContext().messages).find(
          (message) => message.role === "toolResult",
        );
        if (delivered?.role !== "toolResult") {
          throw new Error("Missing model-facing skill result");
        }
        expect(delivered.content).toEqual(produced.content);
        const outerText = delivered.content.find((part) => part.type === "text")!.text;
        const text = deferred
          ? (JSON.parse(outerText).result.content[0].text as string)
          : outerText;
        const match = /\n\n\[Skill page (\d+):(\d+)\/(\d+); nextCursor=(null|"[^"]+")\./u.exec(
          text,
        )!;
        expect(Number(match[1])).toBe(Buffer.byteLength(reconstructed));
        const pageContent = text.slice(text.indexOf("\n\n") + 2, match.index);
        expect(Number(match[2]) - Number(match[1])).toBe(Buffer.byteLength(pageContent));
        reconstructed += pageContent;
        cursor = JSON.parse(match[4]!) ?? undefined;
      } while (cursor);
      expect(reconstructed).toBe(content);
    }
  },
);

it("preserves source boundaries and rejects stale, wrong-document, and malformed cursors", () => {
  for (const content of [
    "",
    "\r\n",
    "😀中é".repeat(500),
    '"\\\t\n'.repeat(500),
    "x".repeat(4000),
  ]) {
    const document = { name: "test", location: "/test/SKILL.md", content };
    let cursor: string | undefined;
    let whole = "";
    do {
      const { details } = createSkillInstructionPage(document, cursor, {
        maxChars: 800,
        maxContextChars: 1600,
      });
      whole += details.content;
      if (details.nextCursor) {
        for (const changed of [
          { ...document, name: "other" },
          { ...document, content: content + "changed" },
        ]) {
          expect(() => createSkillInstructionPage(changed, details.nextCursor)).toThrow(/Restart/);
        }
      }
      cursor = details.nextCursor ?? undefined;
    } while (cursor);
    expect(whole).toBe(content);
    for (const invalid of [null, "", "garbage", "v2:abc:1"]) {
      expect(() => createSkillInstructionPage(document, invalid)).toThrow(/Restart/);
    }
  }
  expect(() =>
    createSkillInstructionPage({ name: "x", location: "x", content: "😀" }, undefined, {
      maxChars: 1,
      maxContextChars: 1,
    }),
  ).toThrow(/cannot fit/);
});

it("does not exempt ordinary oversized tool output from delivery caps", async () => {
  const session = guardSessionManager(SessionManager.inMemory(), { contextWindowTokens: 50_000 });
  const content = [{ type: "text" as const, text: "ordinary output ".repeat(20_000) }];
  await session.appendMessageAsync(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "ordinary", name: "ordinary", arguments: {} }],
      stopReason: "toolUse",
    }),
  );
  await session.appendMessageAsync({
    role: "toolResult",
    toolCallId: "ordinary",
    toolName: "ordinary",
    content,
    isError: false,
    timestamp: 1,
  });
  const delivered = convertToLlm(session.buildSessionContext().messages).find(
    (message) => message.role === "toolResult",
  );
  if (delivered?.role !== "toolResult") {
    throw new Error("Ordinary tool result was dropped instead of capped");
  }
  const text = delivered.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  expect(text.length).toBeGreaterThan(0);
  expect(text.length).toBeLessThan(content[0]!.text.length);
});

it("rechecks source authority, cancellation, and content on continuation", async () => {
  let content = "😀".repeat(1000);
  let active = true;
  const location = "/synthetic/SKILL.md";
  const read = createInstalledSkillTools(
    [
      {
        name: "guide",
        description: "guide",
        location,
        source: { filePath: location },
        assertCurrent() {
          if (!active) {
            throw new Error("revoked");
          }
        },
        async reader() {
          return content;
        },
      },
    ],
    { maxChars: 800, maxContextChars: 1600 },
  )[1]!;
  const first = await read.execute("first", { name: "guide" });
  const cursor = (first.details as { nextCursor: string }).nextCursor;
  expect(cursor).toBeTypeOf("string");
  const invalidBoundary = cursor.replace(/:[0-9]+$/u, ":1");
  await expect(
    read.execute("boundary", { name: "guide", cursor: invalidBoundary }),
  ).rejects.toThrow(/boundary/);
  active = false;
  await expect(read.execute("revoked", { name: "guide", cursor })).rejects.toThrow("revoked");
  active = true;
  await expect(
    read.execute("aborted", { name: "guide", cursor }, AbortSignal.abort()),
  ).rejects.toThrow();
  content += "changed";
  await expect(read.execute("stale", { name: "guide", cursor })).rejects.toThrow(/Restart/);
});

it("isolates concurrent and nested caller page budgets", async () => {
  const { runWithToolResultDeliveryProjection } = await import("../tool-result-limits.js");
  const document = { name: "guide", location: "/guide/SKILL.md", content: "x".repeat(4000) };
  const scoped = (limit: number, run: () => Promise<number>) =>
    runWithToolResultDeliveryProjection((result) => result.content[0]!.text.length <= limit, run);
  const [small, large] = await Promise.all(
    [500, 1000].map((limit) =>
      scoped(limit, async () => {
        await Promise.resolve();
        const before = createSkillInstructionPage(document).details.endByte;
        await scoped(400, async () => {
          await Promise.resolve();
          expect(createSkillInstructionPage(document).details.endByte).toBeLessThan(before);
          return 0;
        });
        expect(createSkillInstructionPage(document).details.endByte).toBe(before);
        return before;
      }),
    ),
  );
  expect(small).toBeLessThan(large!);
});
