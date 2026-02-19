import { isCancel, select, text } from "@clack/prompts";
import type { RuntimeEnv } from "../runtime.js";
import {
  addChatTurn,
  applyResearchSuggestions,
  buildResearchChatContext,
  createResearchChatSession,
  exportResearchDoc,
  formatResearchDocForChat,
  type ResearchChatSession,
} from "../lib/research-chatbot.js";
import { generateOllamaResearchResponse } from "../lib/research-ollama.js";
import { theme } from "../terminal/theme.js";

/**
 * Interactive research chat mode
 * Guides user through multi-turn conversation with LLM
 */
export async function runInteractiveResearchChat(
  runtime: RuntimeEnv,
  options: {
    template?: string;
    outputPath?: string;
  } = {},
): Promise<void> {
  // Initialize session
  const title = await text({
    message: "What is your research about?",
    placeholder: "Research title",
  });

  if (isCancel(title)) {
    runtime.log(theme.muted("Cancelled."));
    return;
  }

  const summary = await text({
    message: "One-line summary (optional):",
    placeholder: "Leave blank to skip",
  });

  let session = createResearchChatSession({
    title: title.trim(),
    summary: isCancel(summary) ? undefined : summary.trim(),
    template: options.template,
  });

  runtime.log("");
  runtime.log(theme.heading("Research Assistant Chat Mode"));
  runtime.log(theme.muted(`Session: ${session.sessionId}`));
  runtime.log("");
  runtime.log(theme.muted("Type your notes, ask questions, or use commands: /show /export /done"));
  runtime.log("");

  // Chat loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userInput = await text({
      message: "You:",
    });

    if (isCancel(userInput)) {
      break;
    }

    const input = userInput.trim();

    // Handle commands
    if (input.startsWith("/")) {
      const cmd = input.split(" ")[0];

      if (cmd === "/show") {
        runtime.log("");
        runtime.log(theme.heading("Current Research Document"));
        runtime.log(formatResearchDocForChat(session.workingDoc));
        runtime.log("");
        continue;
      }

      if (cmd === "/done" || cmd === "/export") {
        await handleExport(runtime, session, options.outputPath);
        break;
      }

      if (cmd === "/help") {
        runtime.log("");
        runtime.log(theme.heading("Commands:"));
        runtime.log("  /show    - Display current research document");
        runtime.log("  /export  - Save and export research");
        runtime.log("  /done    - Finish and export");
        runtime.log("  /help    - Show this help");
        runtime.log("");
        continue;
      }

      runtime.log(theme.warn("Unknown command. Type /help for options.\n"));
      continue;
    }

    if (!input) {
      continue;
    }

    // Add user turn
    session = addChatTurn(session, "user", input);

    // Get context for LLM
    const { systemPrompt } = buildResearchChatContext(session);

    // Generate assistant response using local Ollama instance
    const assistantResponse = await generateOllamaResearchResponse(input, session, {
      systemPrompt,
    });

    runtime.log("");
    runtime.log(theme.info("Assistant:"));
    runtime.log(assistantResponse);
    runtime.log("");

    // Add assistant turn and apply suggestions
    session = addChatTurn(session, "assistant", assistantResponse);
    session = applyResearchSuggestions(session, assistantResponse);
  }

  runtime.log(theme.muted("Research chat session ended."));
}

/**
 * Handle export of research document
 */
async function handleExport(
  runtime: RuntimeEnv,
  session: ResearchChatSession,
  outputPath?: string,
): Promise<void> {
  const format = await select({
    message: "Export format:",
    options: [
      { label: "Markdown (.md)", value: "markdown" },
      { label: "JSON (.json)", value: "json" },
      { label: "Both", value: "both" },
    ],
  });

  if (isCancel(format)) {
    return;
  }

  const markdown = exportResearchDoc(session.workingDoc, "markdown");
  const jsonOutput = exportResearchDoc(session.workingDoc, "json");

  if (outputPath) {
    const fs = await import("fs/promises");
    const path = await import("path");

    const dir = path.dirname(outputPath);
    const base = path.basename(outputPath, path.extname(outputPath));

    if (format === "markdown" || format === "both") {
      const mdPath = path.join(dir, `${base}.md`);
      await fs.writeFile(mdPath, markdown, "utf8");
      runtime.log(theme.success(`✓ Wrote ${mdPath}`));
    }

    if (format === "json" || format === "both") {
      const jsonPath = path.join(dir, `${base}.json`);
      await fs.writeFile(jsonPath, jsonOutput, "utf8");
      runtime.log(theme.success(`✓ Wrote ${jsonPath}`));
    }
  } else {
    runtime.log("");
    if (format === "markdown" || format === "both") {
      runtime.log(markdown);
    }
    if (format === "json" || format === "both") {
      runtime.log(jsonOutput);
    }
  }
}
