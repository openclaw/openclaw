import type { ResearchDoc, Section } from "./section-schema.js";
import { buildResearchDocFromInput } from "./section-extractors.js";

/**
 * Research chatbot turn: user message + assistant response
 */
export type ResearchChatTurn = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

/**
 * Ongoing research chat session
 */
export type ResearchChatSession = {
  sessionId: string;
  turns: ResearchChatTurn[];
  workingDoc: ResearchDoc;
  template?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Build an LLM prompt for research refinement
 */
function buildResearchAssistantSystemPrompt(currentDoc: ResearchDoc): string {
  const sectionsSummary = currentDoc.sections
    .map((s, i) => `${i + 1}. ${s.title || "(untitled)"}: ${s.text.slice(0, 100)}...`)
    .join("\n");

  return `You are a research assistant helping users structure and refine their work.

Current research document:
Title: ${currentDoc.title}
${currentDoc.summary ? `Summary: ${currentDoc.summary}` : ""}

Sections:
${sectionsSummary}

Your role:
1. Ask clarifying questions to help the user refine their research
2. Suggest improvements to existing sections
3. Propose new sections based on the user's feedback
4. Help reorganize and strengthen the narrative
5. Extract and structure unstructured notes into coherent sections

When the user provides new content or feedback:
- Extract actionable insights
- Suggest specific section changes
- Ask follow-up questions if needed
- Be concise and focused

If the user wants to finalize, help them export the document.`;
}

/**
 * Format research doc for display in chat
 */
export function formatResearchDocForChat(doc: ResearchDoc): string {
  const lines = [`# ${doc.title}`, "", doc.summary ? `**Summary:** ${doc.summary}` : "", ""];

  for (const section of doc.sections) {
    lines.push(`## ${section.title || "(Untitled)"}`);
    lines.push(section.text);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Create a new research chat session
 */
export function createResearchChatSession(params: {
  title: string;
  summary?: string;
  template?: string;
}): ResearchChatSession {
  const now = Date.now();
  const doc = buildResearchDocFromInput({
    title: params.title,
    summary: params.summary,
    input: "",
    template: params.template,
  });

  return {
    sessionId: `research-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    turns: [],
    workingDoc: doc,
    template: params.template,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Add a turn to the session and return system prompt + conversation context
 */
export function addChatTurn(
  session: ResearchChatSession,
  role: "user" | "assistant",
  content: string,
): ResearchChatSession {
  return {
    ...session,
    turns: [...session.turns, { role, content, timestamp: Date.now() }],
    updatedAt: Date.now(),
  };
}

/**
 * Build LLM conversation context for research refinement
 */
export function buildResearchChatContext(session: ResearchChatSession): {
  systemPrompt: string;
  conversationHistory: Array<{ role: string; content: string }>;
} {
  const systemPrompt = buildResearchAssistantSystemPrompt(session.workingDoc);

  const conversationHistory = session.turns.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));

  return { systemPrompt, conversationHistory };
}

/**
 * Parse assistant suggestions and update the working document
 * (In Phase 2, this would use structured extraction)
 */
export function applyResearchSuggestions(
  session: ResearchChatSession,
  assistantMessage: string,
): ResearchChatSession {
  // Phase 1: Simple heuristic parsing of suggestions
  // If assistant mentions "new section", extract it
  const newSectionMatch = assistantMessage.match(/## (\w+[\w\s]*?)\n+(.*?)(?=##|$)/s);

  if (newSectionMatch) {
    const [, title, text] = newSectionMatch;
    const newSection: Section = {
      title: title.trim(),
      text: text.trim(),
    };

    return {
      ...session,
      workingDoc: {
        ...session.workingDoc,
        sections: [...session.workingDoc.sections, newSection],
      },
      updatedAt: Date.now(),
    };
  }

  return session;
}

/**
 * Prepare research doc for export (format as markdown or JSON)
 */
export function exportResearchDoc(
  doc: ResearchDoc,
  format: "markdown" | "json" = "markdown",
): string {
  if (format === "json") {
    return JSON.stringify(doc, null, 2);
  }

  // Markdown format
  const lines = [`# ${doc.title}`, ""];

  if (doc.summary) {
    lines.push(`**Summary:** ${doc.summary}`);
    lines.push("");
  }

  for (const section of doc.sections) {
    lines.push(`## ${section.title || "Section"}`);
    lines.push("");
    lines.push(section.text);
    lines.push("");
  }

  if (doc.provenance) {
    lines.push("---");
    lines.push("");
    lines.push(`*Generated via ${doc.provenance.method}*`);
  }

  return lines.join("\n");
}
