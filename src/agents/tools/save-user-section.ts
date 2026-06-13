import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAppUserId } from "../app-user-workspace.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

/**
 * `save_user_section` — lets the agent persist a per-app-user field into that
 * user's per-user workspace file (`users/<appUserId>.md`) as an HTML-comment
 * marker section. This is the WRITE half of the Havaya per-user integration;
 * the dashboard read endpoint (`/api/public/chat/[agentName]/user-file`) serves
 * what this writes. See docs in openclaw-dashboard:docs/peruser-user-file-plan.md
 * and the contract AGENTGLOB_USER_FILE_API.md.
 *
 * Identity is resolved SERVER-SIDE: the integrating app (Havaya) sends an
 * explicit `appUserId` on chat.send, which the gateway persists on the session
 * entry. This tool reads it back via loadSessionEntry(agentSessionKey) — the
 * model never has to know or type the user id. The id is lowercased so it
 * matches the reader (which lowercases the query `userId`).
 */

/** Sections the agent may write via this tool. Mirrors the reader allowlist. */
export const WRITABLE_SECTIONS: readonly string[] = ["User_D_Prompt", "app_note"];

const SaveUserSectionSchema = Type.Object({
  section: Type.String({
    description: "Allowlisted section name, e.g. User_D_Prompt or app_note.",
  }),
  content: Type.String({
    description: "The section's text. Replaces the section if it already exists.",
  }),
});

/**
 * Pure: return `fileContent` with the named section's marker block upserted to
 * `content`. Replaces the block if the markers already exist exactly once;
 * appends a fresh block otherwise. Throws on ambiguous (duplicate) markers so
 * we never silently corrupt a file the reader would then reject.
 */
export function upsertSection(fileContent: string, section: string, content: string): string {
  const start = `<!-- app:${section}:start -->`;
  const end = `<!-- app:${section}:end -->`;
  const block = `${start}\n${content.trim()}\n${end}`;

  const firstStart = fileContent.indexOf(start);
  if (firstStart === -1) {
    // Append a new block; ensure a blank line separates it from prior content.
    const base = fileContent.replace(/\s*$/, "");
    return base ? `${base}\n\n${block}\n` : `${block}\n`;
  }
  const firstEnd = fileContent.indexOf(end, firstStart + start.length);
  if (firstEnd === -1) {
    throw new ToolInputError(`malformed markers for section "${section}" (start without end)`);
  }
  if (
    fileContent.indexOf(start, firstStart + start.length) !== -1 ||
    fileContent.indexOf(end, firstEnd + end.length) !== -1
  ) {
    throw new ToolInputError(`duplicate markers for section "${section}" — refusing to guess`);
  }
  return fileContent.slice(0, firstStart) + block + fileContent.slice(firstEnd + end.length);
}

export function createSaveUserSectionTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  workspaceDir?: string;
  /**
   * Canonical directory for the per-user file, decoupled from `workspaceDir`.
   * App-user sessions run jailed in a per-user cwd, but their user-file must
   * land in the shared agent-home `users/` dir the dashboard reader resolves.
   * Defaults to `<workspaceDir>/users`.
   */
  userFileDir?: string;
}): AnyAgentTool | null {
  // Only offered when we can resolve a workspace to write into.
  if (!options.workspaceDir) {
    return null;
  }
  const workspaceDir = options.workspaceDir;

  return {
    label: "Save User Section",
    name: "save_user_section",
    description:
      "Persist a per-user app field (allowlisted sections: User_D_Prompt, app_note) into this user's per-user file so the connected app can display it. The user is resolved automatically from the session — do not pass a user id. Replaces the section if it already exists.",
    parameters: SaveUserSectionSchema,
    execute: async (_toolCallId, params) => {
      const section = readStringParam(params, "section", { required: true });
      const content =
        readStringParam(params, "content", { required: true, allowEmpty: true }) ?? "";

      if (!WRITABLE_SECTIONS.includes(section)) {
        return jsonResult({
          ok: false,
          error: `section "${section}" is not writable; allowed: ${WRITABLE_SECTIONS.join(", ")}`,
        });
      }

      const appUserId = resolveAppUserId(options.agentSessionKey);
      if (!appUserId) {
        return jsonResult({
          ok: false,
          error:
            "no app user id on this session — save_user_section is only available for app-initiated chats that supply an appUserId",
        });
      }

      const usersDir = options.userFileDir ?? path.join(workspaceDir, "users");
      const filePath = path.join(usersDir, `${appUserId}.md`);
      // Containment: the resolved path must stay inside <workspace>/users/.
      const rel = path.relative(usersDir, filePath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return jsonResult({ ok: false, error: "resolved path escaped the users directory" });
      }

      let existing = "";
      try {
        existing = await fs.readFile(filePath, "utf-8");
      } catch {
        existing = ""; // lazy provisioning — first write creates the file
      }

      let next: string;
      try {
        next = upsertSection(existing, section, content);
      } catch (err) {
        return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }

      await fs.mkdir(usersDir, { recursive: true });
      await fs.writeFile(filePath, next, "utf-8");
      return jsonResult({ ok: true, section, bytes: Buffer.byteLength(next, "utf8") });
    },
  };
}
