import type { SidebarContent } from "../sidebar-content.ts";

function toPlainTextCodeFence(value: string, language = ""): string {
  const fenceHeader = language ? `\`\`\`${language}` : "```";
  return `${fenceHeader}\n${value}\n\`\`\``;
}

function buildRawToolMarkdown(content: Extract<SidebarContent, { kind: "tool" }>): string {
  const sections: string[] = [`## ${content.toolLabel || content.toolName}`];
  sections.push(`**Tool:** \`${content.toolName}\``);
  if (content.detail) {
    sections.push(`**Summary:** ${content.detail}`);
  }
  if (content.inputText?.trim()) {
    sections.push(
      `### Tool input\n${toPlainTextCodeFence(content.inputText, content.inputIsJson ? "json" : "text")}`,
    );
  }
  const rawOutput = content.rawText ?? content.outputText;
  if (rawOutput?.trim()) {
    sections.push(
      `### Tool output\n${toPlainTextCodeFence(rawOutput, content.outputIsJson ? "json" : "text")}`,
    );
  } else {
    sections.push("### Tool output\n*No output — tool completed successfully.*");
  }
  return sections.join("\n\n");
}

export function buildRawSidebarContent(
  content: SidebarContent | null | undefined,
): SidebarContent | null {
  if (!content) {
    return null;
  }
  if (content.kind === "markdown") {
    const rawText = content.rawText ?? content.content;
    return {
      kind: "markdown",
      content: toPlainTextCodeFence(rawText),
      rawText,
    };
  }
  if (content.kind === "tool") {
    const markdown = buildRawToolMarkdown(content);
    return {
      kind: "markdown",
      content: markdown,
      rawText: content.rawText ?? content.outputText ?? content.inputText ?? markdown,
    };
  }
  if (content.rawText?.trim()) {
    return {
      kind: "markdown",
      content: toPlainTextCodeFence(content.rawText, "json"),
    };
  }
  return null;
}
