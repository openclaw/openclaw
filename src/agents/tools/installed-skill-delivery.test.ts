import { expect, it } from "vitest";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { truncateOversizedToolResultsInMessages } from "../embedded-agent-runner/tool-result-truncation.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { convertToLlm } from "../sessions/messages.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../test-helpers/agent-message-fixtures.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "../tool-search-catalog.js";
import { createToolSearchTools } from "../tool-search.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

for (const deferred of [false, true]) {
  it.each(["fits", "live limit", "prompt limit", "envelope limit"] as const)(
    `delivers whole instructions or refuses %s through ${deferred ? "deferred dispatch" : "native read"}`,
    async (scenario) => {
      const body =
        "# Synthetic skill\n" +
        (scenario === "envelope limit"
          ? "x\n".repeat(21_500)
          : "Complete synthetic example.\n".repeat(
              scenario === "live limit" ? 6_500 : scenario === "prompt limit" ? 1_000 : 1,
            )) +
        "END SKILL\n";
      const location = "/synthetic/guide/SKILL.md";
      const expected = `Skill location: ${location}\nResolve relative resource paths from the directory containing this SKILL.md.\n\n${body}`;
      const tools = createInstalledSkillTools([
        {
          name: "guide",
          description: "Synthetic guide",
          location,
          source: { filePath: location, readContent: body },
        },
      ]);
      finalizeAgentToolAvailability(tools);
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({ catalogRef, tools });
      const tool = deferred
        ? createToolSearchTools({
            catalogRef,
            config: { tools: { toolSearch: { enabled: true, mode: "tools" } } },
          }).find((entry) => entry.name === "dispatch_action")!
        : tools.find((entry) => entry.name === "skills_read")!;
      const args = deferred ? { id: "skills_read", args: { name: "guide" } } : { name: "guide" };
      const produced = await tool.execute("read-skill", args);
      const session = guardSessionManager(SessionManager.inMemory(), {
        contextWindowTokens: 300_000,
      });
      await session.appendMessageAsync(makeAgentUserMessage({ content: "Read the guide." }));
      await session.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "read-skill", name: tool.name, arguments: args }],
          stopReason: "toolUse",
        }),
      );
      await session.appendMessageAsync({
        role: "toolResult",
        toolCallId: "read-skill",
        toolName: tool.name,
        ...produced,
        isError: false,
        timestamp: 1,
      });
      const context = session.buildSessionContext().messages;
      const projected =
        scenario === "prompt limit"
          ? truncateOversizedToolResultsInMessages(context, 300_000, 1_024).messages
          : context;
      const delivered = convertToLlm(projected).find((message) => message.role === "toolResult");
      if (delivered?.role !== "toolResult") {
        throw new Error("Skill read was not delivered to the model context");
      }
      const text = delivered.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      if (scenario === "fits" || (scenario === "envelope limit" && !deferred)) {
        if (deferred) {
          expect(JSON.parse(text)).toMatchObject({
            result: { content: [{ type: "text", text: expected }] },
          });
        } else {
          expect(text).toBe(expected);
        }
      } else {
        expect(
          text.startsWith("Skill instructions cannot be partially served:"),
          `instructions=${expected.length} delivered=${text.length}`,
        ).toBe(true);
      }
    },
  );
}
