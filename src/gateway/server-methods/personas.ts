/**
 * Persona library RPC handlers.
 *
 * Exposes the centralized persona template library for the agent creation
 * wizard (CLI + UI). All methods read from the persona index and persona
 * files on disk — no database writes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expandPersona, loadPersonaBySlug } from "../../agents/persona-expansion.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Resolve personas directory ──────────────────────────────────────────────

function resolvePersonasDir(): string {
  return join(import.meta.dirname, "..", "..", "..", "agents", "personas");
}

async function loadIndex(): Promise<{
  personas: Array<{
    slug: string;
    name: string;
    description: string;
    category: string;
    role?: string;
    department?: string;
    emoji: string;
    tags?: string[];
    path: string;
  }>;
  categories: Array<{ slug: string; name: string; count: number }>;
} | null> {
  const indexPath = join(resolvePersonasDir(), "_index.json");
  try {
    const content = await readFile(indexPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

export const personasHandlers: GatewayRequestHandlers = {
  /**
   * List available persona templates with optional filters.
   * Params: { category?: string, tag?: string, limit?: number, offset?: number }
   */
  "personas.list": async ({ params, respond }) => {
    const index = await loadIndex();
    if (!index) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, "Persona index not found"));
      return;
    }

    let filtered = index.personas;

    const category = typeof params.category === "string" ? params.category.trim() : "";
    if (category) {
      filtered = filtered.filter((p) => p.category === category);
    }

    const tag = typeof params.tag === "string" ? params.tag.trim() : "";
    if (tag) {
      filtered = filtered.filter((p) => p.tags?.includes(tag));
    }

    const offset = typeof params.offset === "number" ? Math.max(0, params.offset) : 0;
    const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    respond(true, { personas: paginated, total: filtered.length }, undefined);
  },

  /**
   * Get full persona content by slug.
   * Params: { slug: string }
   */
  "personas.get": async ({ params, respond }) => {
    const slug = typeof params.slug === "string" ? params.slug.trim() : "";
    if (!slug) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Missing slug parameter"));
      return;
    }

    const personasDir = resolvePersonasDir();
    const persona = await loadPersonaBySlug(personasDir, slug);
    if ("error" in persona) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, persona.error));
      return;
    }

    respond(
      true,
      {
        slug: persona.frontmatter.slug,
        name: persona.frontmatter.name,
        description: persona.frontmatter.description,
        category: persona.frontmatter.category,
        role: persona.frontmatter.role,
        department: persona.frontmatter.department,
        emoji: persona.frontmatter.emoji,
        vibe: persona.frontmatter.vibe,
        tags: persona.frontmatter.tags,
        tools: persona.frontmatter.tools,
        tier: persona.frontmatter.tier,
        capabilities: persona.frontmatter.capabilities,
        body: persona.body,
        sections: Object.fromEntries(persona.sections),
      },
      undefined,
    );
  },

  /**
   * List available categories with counts.
   */
  "personas.categories": async ({ respond }) => {
    const index = await loadIndex();
    if (!index) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, "Persona index not found"));
      return;
    }

    respond(true, { categories: index.categories }, undefined);
  },

  /**
   * Search personas by name, description, tags.
   * Params: { query: string, limit?: number }
   */
  "personas.search": async ({ params, respond }) => {
    const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Missing query parameter"));
      return;
    }

    const index = await loadIndex();
    if (!index) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, "Persona index not found"));
      return;
    }

    const matches = index.personas.filter((p) => {
      const haystack = [p.name, p.description, p.slug, p.category, ...(p.tags ?? [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

    const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : matches.length;
    respond(true, { personas: matches.slice(0, limit), total: matches.length }, undefined);
  },

  /**
   * Preview expansion of a persona into agent files (dry run — no disk writes).
   * Params: { slug: string, agentName: string, agentId: string, overrides?: object }
   */
  "personas.expand": async ({ params, respond }) => {
    const slug = typeof params.slug === "string" ? params.slug.trim() : "";
    const agentName = typeof params.agentName === "string" ? params.agentName.trim() : "";
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";

    if (!slug || !agentName || !agentId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Missing required parameters: slug, agentName, agentId",
        ),
      );
      return;
    }

    const personasDir = resolvePersonasDir();
    const persona = await loadPersonaBySlug(personasDir, slug);
    if ("error" in persona) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, persona.error));
      return;
    }

    const overrides =
      params.overrides && typeof params.overrides === "object"
        ? (params.overrides as Record<string, unknown>)
        : undefined;

    const result = await expandPersona(persona, { agentName, agentId, overrides });
    if ("error" in result) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, result.error));
      return;
    }

    respond(
      true,
      {
        agentMd: result.agentMd,
        workspaceFiles: result.workspaceFiles.map((f) => ({
          name: f.name,
          content: f.content,
          size: f.content.length,
        })),
      },
      undefined,
    );
  },
};
