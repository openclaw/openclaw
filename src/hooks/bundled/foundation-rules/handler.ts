import { readFile } from "fs/promises";
import { join } from "path";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const HOOK_KEY = "foundation-rules";
const RULES_FILE = "CRITICAL-RULES.md";
const INJECTED_FILE_PATH = "CRITICAL-RULES-ACTIVE.md";

/**
 * Simple markdown parser that extracts sections and their content
 */
function parseMarkdownSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split("\n");
  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    // Check for heading (## Section Name)
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      // Save previous section if exists
      if (currentSection && currentContent.length > 0) {
        sections.set(currentSection.toLowerCase(), currentContent.join("\n").trim());
      }
      // Start new section
      currentSection = headingMatch[1].trim();
      currentContent = [];
    } else if (currentSection) {
      // Add line to current section
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentSection && currentContent.length > 0) {
    sections.set(currentSection.toLowerCase(), currentContent.join("\n").trim());
  }

  return sections;
}

/**
 * Filter and format rules based on context
 */
function buildContextualRules(sections: Map<string, string>, channel?: string): string {
  const parts: string[] = [];

  // Add channel rules section
  // Note: Since channel info is not available in agent:bootstrap context,
  // we include all channel rules when channel is undefined
  const channelRules = sections.get("channel rules");
  if (channelRules) {
    if (channel) {
      // Extract only the rule for this specific channel
      const lines = channelRules.split("\n");
      const relevantLines = lines.filter((line) => {
        const normalized = line.toLowerCase();
        return normalized.includes(channel.toLowerCase());
      });

      if (relevantLines.length > 0) {
        parts.push("## Channel Rules (Active)");
        parts.push(relevantLines.join("\n"));
      }
    } else {
      // Include all channel rules when channel is unknown
      parts.push("## Channel Rules");
      parts.push(channelRules);
    }
  }

  // Add generic sections that should always be included
  const genericSections = [
    "banned phrases",
    "critical reminders",
    "formatting rules",
    "task-specific rules",
  ];

  for (const sectionName of genericSections) {
    const content = sections.get(sectionName);
    if (content) {
      parts.push(
        `## ${sectionName
          .split(" ")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ")}`,
      );
      parts.push(content);
    }
  }

  return parts.join("\n\n");
}

const foundationRulesHook: HookHandler = async (event) => {
  // Only handle agent:bootstrap events
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;

  // Skip for subagents
  if (context.sessionKey && isSubagentSessionKey(context.sessionKey)) {
    return;
  }

  // Check if hook is enabled
  const cfg = context.cfg;
  const hookConfig = resolveHookConfig(cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  // Verify we have required context
  const workspaceDir = context.workspaceDir;
  if (!workspaceDir || !Array.isArray(context.bootstrapFiles)) {
    return;
  }

  // Calculate current bootstrap context size (approximate token count)
  // Each bootstrap file contributes its content length
  const currentContextSize = context.bootstrapFiles.reduce((total, file) => {
    const content = file.content || "";
    // Rough approximation: 4 chars per token
    return total + Math.ceil(content.length / 4);
  }, 0);

  // Check if we're below threshold (default 150k tokens, configurable)
  const maxContextTokens = (hookConfig as any)?.maxContextTokens ?? 150000;
  if (currentContextSize >= maxContextTokens) {
    console.debug(
      `[foundation-rules] Skipping injection: context size ${currentContextSize} exceeds threshold ${maxContextTokens}`,
    );
    return;
  }

  // Read CRITICAL-RULES.md from workspace
  const rulesPath = join(workspaceDir, RULES_FILE);
  let rulesContent: string;

  try {
    rulesContent = await readFile(rulesPath, "utf-8");
  } catch (err) {
    // File not found is OK - just skip silently
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    // Log other errors but don't fail
    console.warn(`[foundation-rules] Failed to read ${RULES_FILE}:`, err);
    return;
  }

  // Parse markdown sections
  const sections = parseMarkdownSections(rulesContent);

  if (sections.size === 0) {
    // No sections found, skip
    return;
  }

  // Note: commandSource is not available in agent:bootstrap events,
  // so we cannot filter by channel. Inject all rules instead.
  const activeRules = buildContextualRules(sections, undefined);

  if (!activeRules) {
    // No relevant rules for this context
    return;
  }

  // Inject at END of bootstrap files for highest attention weight
  context.bootstrapFiles.push({
    path: INJECTED_FILE_PATH,
    content: `# Critical Rules (Active)\n\n${activeRules}\n\n---\n\nThese rules have the highest priority. Review them before responding.`,
  });

  console.debug(`[foundation-rules] Injected rules (all sections)`);
};

export default foundationRulesHook;
