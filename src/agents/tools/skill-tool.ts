import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  createSkill,
  getSkillByName,
  invalidateSkillsMaterializeCache,
  listSkills,
  materializeSkillsForUser,
  resolveSkillUserId,
  updateSkill,
} from "../../infra/skills-mysql.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { bumpSkillsSnapshotVersion } from "../skills/refresh-state.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

const log = createSubsystemLogger("skill-tool");

// Names map 1:1 onto a `<workspaceDir>/skills/<name>/` directory at materialize
// time, so keep them to a single safe path segment. The model can pick a slug.
const SKILL_NAME_PATTERN = /^[\w.-]+$/;
const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;
const MAX_CATEGORY_LEN = 128;
// Stay under skills.limits.maxSkillFileBytes (default 256_000) with headroom.
const MAX_CONTENT_BYTES = 200_000;
const SKILL_SOURCE = "agent";

type SkillToolOptions = {
  /** Trusted session key — the only source of the user id (never model args). */
  agentSessionKey?: string;
  /** Real workspace dir used to materialize the saved skill to disk. */
  workspaceDir?: string;
  agentId?: string;
  config?: OpenClawConfig;
};

/**
 * Resolve the numeric skills `user_id` from the trusted session key/agent id.
 * The model never supplies the user id, so a saved skill can only ever land in
 * the requesting user's own catalog.
 */
function resolveTrustedUserId(opts?: SkillToolOptions): number {
  const raw = resolveSkillUserId(opts?.agentSessionKey, opts?.agentId);
  const numeric = raw ? Number(raw) : Number.NaN;
  if (!raw || !Number.isInteger(numeric) || numeric <= 0) {
    throw new ToolInputError(
      "skill tools require a per-user agent session: could not resolve a numeric user id from the current session.",
    );
  }
  return numeric;
}

function validateSkillName(name: string): string {
  if (name.length > MAX_NAME_LEN) {
    throw new ToolInputError(`name too long (max ${MAX_NAME_LEN} characters)`);
  }
  if (name === "." || name === ".." || !SKILL_NAME_PATTERN.test(name)) {
    throw new ToolInputError(
      "name must be a single safe slug using only letters, digits, '.', '_' or '-' (e.g. my-research-flow)",
    );
  }
  return name;
}

const SkillSaveToolSchema = Type.Object({
  name: Type.String({
    description:
      "Skill slug (letters/digits/.-_ only). Reusing an existing name overwrites that skill.",
  }),
  description: Type.String({
    description: "One-line summary used to decide when this skill applies. Keep it specific.",
  }),
  content: Type.String({
    description:
      "Full SKILL.md body (markdown). Capture the reusable workflow: what it does, when to use it, and the concrete steps/commands.",
  }),
  category: Type.Optional(Type.String({ description: "Optional grouping label." })),
});

const SkillListToolSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max skills to return (default 50)." })),
});

/**
 * skill_save — persist the current conversation's flow as a reusable skill in
 * the user's DB-backed catalog. Upserts by name (create or overwrite), then
 * materializes it to disk and bumps the skills snapshot version so it becomes
 * available from the user's next message — no gateway restart required.
 */
export function createSkillSaveTool(opts?: SkillToolOptions): AnyAgentTool {
  return {
    label: "Save skill",
    name: "skill_save",
    description:
      "Save the current workflow as a reusable skill for this user (DB-backed). Provide a slug name, a specific one-line description, and the full SKILL.md body in `content`. Reusing an existing name overwrites it. The skill becomes available as a skill from the user's next message (no restart).",
    parameters: SkillSaveToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const userId = resolveTrustedUserId(opts);

      const name = validateSkillName(readStringParam(params, "name", { required: true }));
      const description = readStringParam(params, "description", { required: true });
      if (description.length > MAX_DESCRIPTION_LEN) {
        throw new ToolInputError(`description too long (max ${MAX_DESCRIPTION_LEN} characters)`);
      }
      const content = readStringParam(params, "content", { required: true });
      if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
        throw new ToolInputError(`content too large (max ${MAX_CONTENT_BYTES} bytes)`);
      }
      const category = readStringParam(params, "category");
      if (category && category.length > MAX_CATEGORY_LEN) {
        throw new ToolInputError(`category too long (max ${MAX_CATEGORY_LEN} characters)`);
      }

      let action: "created" | "updated";
      let id: number;
      try {
        const existing = await getSkillByName(name, userId);
        if (existing) {
          await updateSkill(
            existing.id,
            { name, description, content, source: SKILL_SOURCE, category, is_enable: 1 },
            userId,
          );
          action = "updated";
          id = existing.id;
        } else {
          const created = await createSkill(
            { name, description, content, source: SKILL_SOURCE, category },
            userId,
          );
          action = "created";
          id = created.id;
        }
      } catch (err) {
        // Never surface raw DB/SQL errors (host, query fragments) to the model
        // output — keep the failure generic and log details internally.
        log.warn(`skill_save: persisting "${name}" failed: ${formatErrorMessage(err)}`);
        throw new ToolInputError("Could not save the skill right now. Please try again.");
      }

      // Make the saved skill visible to the next turn: drop the materialize
      // short-circuit, re-write SKILL.md to disk + reprime the cache, then bump
      // the snapshot version so the run loop rebuilds <available_skills>.
      invalidateSkillsMaterializeCache();
      if (opts?.workspaceDir) {
        try {
          await materializeSkillsForUser(opts.workspaceDir, String(userId));
        } catch (err) {
          // Non-fatal: the DB write already committed; the next turn's own
          // materialize pass will pick it up even if this best-effort one fails.
          log.warn(`skill_save: materialize after save failed: ${formatErrorMessage(err)}`);
        }
      }
      bumpSkillsSnapshotVersion({
        workspaceDir: opts?.workspaceDir,
        reason: "manual",
        changedPath: `skills/${name}/SKILL.md`,
      });

      return jsonResult({
        ok: true,
        action,
        id,
        name,
        note: "Skill saved. It will be available as a skill from your next message in this conversation (no restart needed).",
      });
    },
  };
}

/**
 * skill_list — list the user's own saved skills so the agent can check existing
 * names/descriptions before saving (e.g. to deliberately overwrite one).
 */
export function createSkillListTool(opts?: SkillToolOptions): AnyAgentTool {
  return {
    label: "List skills",
    name: "skill_list",
    description:
      "List this user's saved (DB-backed) skills with their names and descriptions. Use before skill_save to see existing names you might overwrite.",
    parameters: SkillListToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const userId = resolveTrustedUserId(opts);
      const limit = readNumberParam(params, "limit", { integer: true });

      let skills: Awaited<ReturnType<typeof listSkills>>["skills"];
      let total: number;
      try {
        ({ skills, total } = await listSkills(userId, {
          limit: limit !== undefined && limit > 0 ? limit : undefined,
        }));
      } catch (err) {
        log.warn(`skill_list failed: ${formatErrorMessage(err)}`);
        throw new ToolInputError("Could not list skills right now. Please try again.");
      }
      return jsonResult({
        ok: true,
        total,
        skills: skills.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description ?? "",
          enabled: row.is_enable === 1,
          source: row.source,
          category: row.category ?? undefined,
        })),
      });
    },
  };
}
