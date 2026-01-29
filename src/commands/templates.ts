import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";

export type ResponseTemplate = {
  id: string;
  name: string;
  content: string;
  /** Optional per-channel content overrides (channel id -> content). */
  channels?: Record<string, string>;
  /** Optional agent filter: only available for these agents. */
  agents?: string[];
  /** Variable placeholders used in this template (informational). */
  variables?: string[];
  createdAt: string;
  updatedAt: string;
};

type TemplateStore = {
  templates: ResponseTemplate[];
};

const TEMPLATES_FILENAME = "templates.json";

function resolveTemplatesPath(stateDir: string): string {
  return path.join(stateDir, TEMPLATES_FILENAME);
}

export function loadTemplates(stateDir?: string): ResponseTemplate[] {
  const dir = stateDir ?? resolveStateDir();
  const templatesPath = resolveTemplatesPath(dir);
  try {
    const raw = fs.readFileSync(templatesPath, "utf-8");
    const parsed = JSON.parse(raw) as TemplateStore;
    return parsed.templates ?? [];
  } catch {
    return [];
  }
}

async function saveTemplates(templates: ResponseTemplate[], stateDir?: string): Promise<void> {
  const dir = stateDir ?? resolveStateDir();
  const templatesPath = resolveTemplatesPath(dir);
  await fs.promises.mkdir(path.dirname(templatesPath), { recursive: true });
  const store: TemplateStore = { templates };
  await fs.promises.writeFile(templatesPath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Expand template variables in content.
 * Supported variables: {senderName}, {date}, {time}, {channel}, {agentName}, and custom vars.
 */
export function expandTemplateVariables(
  content: string,
  vars: Record<string, string> = {},
): string {
  const now = new Date();
  const builtins: Record<string, string> = {
    date: now.toISOString().split("T")[0],
    time: now.toTimeString().split(" ")[0],
    datetime: now.toISOString(),
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, "0"),
    day: String(now.getDate()).padStart(2, "0"),
    ...vars,
  };

  return content.replace(/\{(\w+)\}/g, (match, key: string) => {
    const lower = key.toLowerCase();
    return builtins[lower] ?? builtins[key] ?? match;
  });
}

/**
 * Find a template by id or name (case-insensitive partial match on name).
 */
export function findTemplate(
  templates: ResponseTemplate[],
  idOrName: string,
): ResponseTemplate | undefined {
  // Exact id match first
  const byId = templates.find((t) => t.id === idOrName);
  if (byId) return byId;

  // Case-insensitive name match
  const lower = idOrName.toLowerCase();
  return templates.find((t) => t.name.toLowerCase() === lower);
}

/**
 * Resolve template content for a specific channel (falls back to default content).
 */
export function resolveTemplateContent(template: ResponseTemplate, channel?: string): string {
  if (channel && template.channels?.[channel]) {
    return template.channels[channel];
  }
  return template.content;
}

// ── CLI commands ──

export type TemplatesListOptions = {
  json?: boolean;
  agent?: string;
};

export async function templatesListCommand(
  opts: TemplatesListOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  let templates = loadTemplates();

  if (opts.agent) {
    templates = templates.filter(
      (t) => !t.agents || t.agents.length === 0 || t.agents.includes(opts.agent!),
    );
  }

  if (opts.json) {
    runtime.log(JSON.stringify({ count: templates.length, templates }, null, 2));
    return;
  }

  if (templates.length === 0) {
    runtime.log("No response templates configured.");
    runtime.log(info('Use "moltbot templates add" to create one.'));
    return;
  }

  const rich = isRich();
  runtime.log(info(`Response templates (${templates.length}):`));
  runtime.log("");

  for (const t of templates) {
    const agents = t.agents?.length ? ` [${t.agents.join(", ")}]` : "";
    const channels = t.channels ? ` (${Object.keys(t.channels).join(", ")} overrides)` : "";
    const preview = t.content.length > 80 ? `${t.content.slice(0, 80)}...` : t.content;

    if (rich) {
      runtime.log(`  ${theme.accent(t.id)} ${theme.heading(t.name)}${agents}${channels}`);
      runtime.log(`  ${theme.muted(preview)}`);
    } else {
      runtime.log(`  ${t.id} ${t.name}${agents}${channels}`);
      runtime.log(`  ${preview}`);
    }
    runtime.log("");
  }
}

export type TemplatesAddOptions = {
  id: string;
  name: string;
  content: string;
  agents?: string;
  channels?: string;
};

export async function templatesAddCommand(
  opts: TemplatesAddOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const templates = loadTemplates();
  const existing = templates.find((t) => t.id === opts.id);
  if (existing) {
    runtime.error(`Template with id "${opts.id}" already exists. Use "templates update" to modify.`);
    return;
  }

  // Extract variables from content
  const varMatches = opts.content.match(/\{(\w+)\}/g) ?? [];
  const variables = [...new Set(varMatches.map((m) => m.slice(1, -1)))];

  const channelOverrides: Record<string, string> | undefined = opts.channels
    ? parseChannelOverrides(opts.channels)
    : undefined;

  const now = new Date().toISOString();
  const template: ResponseTemplate = {
    id: opts.id,
    name: opts.name,
    content: opts.content,
    variables: variables.length > 0 ? variables : undefined,
    agents: opts.agents ? opts.agents.split(",").map((a) => a.trim()) : undefined,
    channels: channelOverrides,
    createdAt: now,
    updatedAt: now,
  };

  templates.push(template);
  await saveTemplates(templates);
  runtime.log(info(`Template "${opts.name}" (${opts.id}) added.`));
  if (variables.length > 0) {
    runtime.log(info(`Variables: ${variables.join(", ")}`));
  }
}

export type TemplatesRemoveOptions = {
  id: string;
};

export async function templatesRemoveCommand(
  opts: TemplatesRemoveOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const templates = loadTemplates();
  const idx = templates.findIndex((t) => t.id === opts.id);
  if (idx === -1) {
    runtime.error(`Template "${opts.id}" not found.`);
    return;
  }

  const removed = templates.splice(idx, 1)[0];
  await saveTemplates(templates);
  runtime.log(info(`Template "${removed.name}" (${removed.id}) removed.`));
}

export type TemplatesShowOptions = {
  id: string;
  channel?: string;
  expand?: boolean;
  vars?: string;
};

export async function templatesShowCommand(
  opts: TemplatesShowOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const templates = loadTemplates();
  const template = findTemplate(templates, opts.id);
  if (!template) {
    runtime.error(`Template "${opts.id}" not found.`);
    return;
  }

  let content = resolveTemplateContent(template, opts.channel);
  if (opts.expand) {
    const vars = opts.vars ? parseVars(opts.vars) : {};
    content = expandTemplateVariables(content, vars);
  }

  const rich = isRich();
  runtime.log(rich ? theme.heading(template.name) : template.name);
  runtime.log(rich ? theme.muted(`ID: ${template.id}`) : `ID: ${template.id}`);
  if (template.agents?.length) {
    runtime.log(rich ? theme.muted(`Agents: ${template.agents.join(", ")}`) : `Agents: ${template.agents.join(", ")}`);
  }
  if (template.channels) {
    runtime.log(
      rich
        ? theme.muted(`Channel overrides: ${Object.keys(template.channels).join(", ")}`)
        : `Channel overrides: ${Object.keys(template.channels).join(", ")}`,
    );
  }
  runtime.log("");
  runtime.log(content);
}

export type TemplatesUpdateOptions = {
  id: string;
  name?: string;
  content?: string;
  agents?: string;
};

export async function templatesUpdateCommand(
  opts: TemplatesUpdateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const templates = loadTemplates();
  const template = templates.find((t) => t.id === opts.id);
  if (!template) {
    runtime.error(`Template "${opts.id}" not found.`);
    return;
  }

  if (opts.name) template.name = opts.name;
  if (opts.content) {
    template.content = opts.content;
    const varMatches = opts.content.match(/\{(\w+)\}/g) ?? [];
    template.variables = [...new Set(varMatches.map((m) => m.slice(1, -1)))];
  }
  if (opts.agents) {
    template.agents = opts.agents.split(",").map((a) => a.trim());
  }
  template.updatedAt = new Date().toISOString();

  await saveTemplates(templates);
  runtime.log(info(`Template "${template.name}" (${template.id}) updated.`));
}

// ── Helpers ──

function parseChannelOverrides(raw: string): Record<string, string> {
  // Format: "telegram:Hello from TG,discord:Hello from Discord"
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx > 0) {
      const channel = pair.slice(0, colonIdx).trim();
      const content = pair.slice(colonIdx + 1).trim();
      if (channel && content) result[channel] = content;
    }
  }
  return Object.keys(result).length > 0 ? result : {};
}

function parseVars(raw: string): Record<string, string> {
  // Format: "key1=value1,key2=value2"
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      const key = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (key) result[key] = value;
    }
  }
  return result;
}
