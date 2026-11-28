import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  replaceSessionEntry,
  resolveSessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createEmbeddedCallGateway } from "./embedded-gateway-stub.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { readHistoryDetails } from "./sessions-history-tool.test-support.js";

it("recovers bounded text and pages stored rows through the embedded history adapter", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = await captureRuntimeConfigAsyncReader()();
    const scope = { agentId: "main", sessionKey: "agent:main:main", sessionId: "embedded-history" };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const target = await resolveSessionTranscriptRuntimeTarget(scope);
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const text = "visible-" + "v".repeat(16_000 - 8);
    await manager.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    });
    const tool = createSessionsHistoryTool({
      config,
      agentSessionKey: scope.sessionKey,
      callGateway: createEmbeddedCallGateway(),
    });
    const normal = readHistoryDetails(await tool.execute("default", { sessionKey: "current" }));
    expect(normal).toMatchObject({ contentTruncated: true });
    expect(JSON.stringify(normal.messages)).not.toContain(text);
    const expanded = readHistoryDetails(
      await tool.execute("expanded", { sessionKey: "current", maxChars: 16_000 }),
    );
    expect(expanded).toMatchObject({
      contentTruncated: false,
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });

    const longer = [1, 2, 3].map((index) => `${index}:` + "p".repeat(39_998));
    for (const content of longer) {
      await manager.appendMessageAsync({
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: 2,
      });
    }
    const first = readHistoryDetails(
      await tool.execute("first-page", { sessionKey: "current", offset: 0, maxChars: 64_000 }),
    );
    expect(first).toMatchObject({ droppedMessages: true, hasMore: true, nextOffset: 2 });
    const second = readHistoryDetails(
      await tool.execute("second-page", {
        sessionKey: "current",
        offset: first.nextOffset,
        maxChars: 64_000,
      }),
    );
    expect(second).toMatchObject({ hasMore: false });
    const recovered = [second, first].flatMap((page) => {
      expect(Number(page.bytes)).toBeLessThanOrEqual(80 * 1024);
      return (Array.isArray(page.messages) ? page.messages : []).map((message: unknown) => {
        const content = asOptionalRecord(message)?.content;
        return Array.isArray(content) ? asOptionalRecord(content[0])?.text : undefined;
      });
    });
    expect(recovered).toEqual([text, ...longer]);
  });
});
