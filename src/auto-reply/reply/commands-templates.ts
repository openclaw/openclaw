import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "default-templates",
);

export function resolveTemplatesDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".openclaw", "templates");
}

// ---------------------------------------------------------------------------
// Bootstrap defaults on first use
// ---------------------------------------------------------------------------

function ensureTemplatesDir(templatesDir: string): void {
  if (!fs.existsSync(templatesDir)) {
    fs.mkdirSync(templatesDir, { recursive: true });
    logVerbose(`Created templates directory: ${templatesDir}`);
  }

  if (!fs.existsSync(DEFAULT_TEMPLATES_DIR)) {
    return;
  }

  for (const file of fs.readdirSync(DEFAULT_TEMPLATES_DIR)) {
    if (!file.endsWith(".md")) {
      continue;
    }
    const dest = path.join(templatesDir, file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(DEFAULT_TEMPLATES_DIR, file), dest);
      logVerbose(`Installed default template: ${file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Template listing & loading
// ---------------------------------------------------------------------------

export type TemplateInfo = {
  name: string;
  path: string;
  preview: string;
};

export function listTemplates(): TemplateInfo[] {
  const templatesDir = resolveTemplatesDir();
  ensureTemplatesDir(templatesDir);

  let files: string[];
  try {
    files = fs.readdirSync(templatesDir);
  } catch {
    return [];
  }

  return files
    .filter((f) => f.endsWith(".md"))
    .toSorted()
    .map((file) => {
      const filePath = path.join(templatesDir, file);
      const name = file.replace(/\.md$/, "");
      let preview = "";
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
        preview = firstLine.slice(0, 80) + (firstLine.length > 80 ? "…" : "");
      } catch {
        preview = "(unreadable)";
      }
      return { name, path: filePath, preview };
    });
}

export function loadTemplate(name: string): string | null {
  const templatesDir = resolveTemplatesDir();
  ensureTemplatesDir(templatesDir);

  // Sanitise: only allow simple alphanumeric/dash/underscore names
  if (!/^[\w-]+$/.test(name)) {
    return null;
  }

  const filePath = path.join(templatesDir, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/** Handles `/templates` — lists available templates. */
export const handleTemplatesCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/templates") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /templates from unauthorized sender: ${params.command.senderId ?? "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const templates = listTemplates();
  const templatesDir = resolveTemplatesDir();

  if (templates.length === 0) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "📂 No templates found.",
          "",
          `Create \`.md\` files in \`${templatesDir}\` and type \`/name\` to expand them as prompts.`,
        ].join("\n"),
      },
    };
  }

  const lines = [
    `📂 **Prompt templates** (${templatesDir})`,
    "",
    ...templates.map((t) => `• \`/${t.name}\` — ${t.preview}`),
    "",
    "Type `/name` to expand a template as a prompt to the agent.",
  ];

  return {
    shouldContinue: false,
    reply: { text: lines.join("\n") },
  };
};

/**
 * Intercepts `/name` patterns and expands matching templates.
 *
 * When a template is found the handler returns `{ shouldContinue: true,
 * expandedBody }` so the pipeline replaces the inbound body with the template
 * content before forwarding to the agent runner.
 */
export const handleTemplateExpansion: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized.trim();

  // Must be a bare `/word` — no spaces, no trailing args
  const match = body.match(/^\/([\w-]+)\s*$/);
  if (!match) {
    return null;
  }

  const templateName = match[1];

  // Let the explicit `/templates` handler take priority
  if (templateName === "templates") {
    return null;
  }

  const content = loadTemplate(templateName);
  if (content === null) {
    // Not a known template — fall through to other handlers / agent
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring template expansion /${templateName} from unauthorized sender: ${params.command.senderId ?? "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  logVerbose(`Expanding template: ${templateName}`);

  // Return shouldContinue:true with the template body so the pipeline
  // (get-reply-inline-actions.ts) replaces sessionCtx and the agent
  // receives the template content as the user's prompt.
  return {
    shouldContinue: true,
    expandedBody: content,
  };
};
