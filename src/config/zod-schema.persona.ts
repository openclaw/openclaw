/**
 * Persona blueprint template schema.
 *
 * Validates YAML frontmatter in persona `.md` files under `agents/personas/`.
 * Personas are generation-time blueprints that drive agent workspace file
 * creation during agent setup.
 */
import { z } from "zod";

// ── Persona frontmatter schema ──────────────────────────────────────────────

export const PersonaFrontmatterSchema = z
  .object({
    // Required fields
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/, "Persona slug must be lowercase alphanumeric with hyphens"),
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    role: z.string().min(1),
    department: z.string().min(1),
    emoji: z.string().min(1),

    // Optional metadata
    color: z.string().optional(),
    vibe: z.string().optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional(),
    author: z.string().optional(),
    source: z.string().optional(),

    // Suggested agent config (used during expansion to populate AGENT.md frontmatter)
    // `tools` is a flat string[] here; mapped to `{ allow: [...] }` during expansion
    tools: z.array(z.string()).optional(),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .strict();

export type PersonaFrontmatter = z.infer<typeof PersonaFrontmatterSchema>;

// ── Persona index manifest schema ───────────────────────────────────────────

const PersonaIndexEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  role: z.string().optional(),
  department: z.string().optional(),
  emoji: z.string(),
  tags: z.array(z.string()).optional(),
  path: z.string(),
});

export type PersonaIndexEntry = z.infer<typeof PersonaIndexEntrySchema>;

const PersonaCategorySchema = z.object({
  slug: z.string(),
  name: z.string(),
  count: z.number().int().nonnegative(),
});

export type PersonaCategory = z.infer<typeof PersonaCategorySchema>;

export const PersonaIndexSchema = z.object({
  version: z.literal(1),
  generated: z.string(),
  personas: z.array(PersonaIndexEntrySchema),
  categories: z.array(PersonaCategorySchema),
});

export type PersonaIndex = z.infer<typeof PersonaIndexSchema>;
