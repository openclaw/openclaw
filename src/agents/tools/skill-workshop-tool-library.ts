import { Type } from "typebox";
import { Value } from "typebox/value";
import { SkillLibraryWorkshopSchema } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { decodeSkillLibraryFile, validateSkillLibraryPath } from "../../skills/library/bundle.js";
import { ToolInputError, type AnyAgentTool } from "./common.js";
import {
  createLibrarySkillWorkshopDeclaration,
  personalWorkshopArguments,
} from "./skill-workshop-tool-declaration.js";
import { jsonResult } from "./tool-results.js";

export function createLibrarySkillWorkshopTool(
  capability: SkillLibraryAuthoringCapability,
  workspace?: AnyAgentTool,
  run: { sandboxed?: boolean } = {},
): AnyAgentTool {
  const schema = workspace
    ? Type.Object(
        { ...SkillLibraryWorkshopSchema.properties, target: Type.Literal("personal") },
        { additionalProperties: false },
      )
    : SkillLibraryWorkshopSchema;
  return {
    name: "skill_workshop",
    label: "Skill Workshop",
    displaySummary: "Author reusable skills",
    ...createLibrarySkillWorkshopDeclaration(capability, workspace),
    execute: async (id, raw) => {
      if (workspace && (!raw || typeof raw !== "object" || !("target" in raw))) {
        capability.assertWorkspaceCurrent?.({ sandboxed: run.sandboxed });
        return workspace.execute(id, raw);
      }
      if (!Value.Check(schema, raw)) {
        const issues = Value.Errors(schema, raw)
          .slice(0, 3)
          .map((error) => {
            const path = JSON.stringify((error.instancePath || "/").slice(0, 120));
            if (error.keyword === "additionalProperties") {
              const fields = error.params.additionalProperties
                .slice(0, 3)
                .map((field) => JSON.stringify(field.slice(0, 120)))
                .join(", ");
              return `${path}: unsupported fields ${fields}`;
            }
            return `${path}: ${error.message}`;
          });
        throw new ToolInputError(
          `Invalid personal Skill Workshop arguments: ${issues.join("; ")}. ${personalWorkshopArguments}${workspace ? " Omit target for Workshop actions." : ""}`,
        );
      }
      const result = await capability.invoke({
        action: raw.action,
        skillId: raw.skill_id,
        expectedRevision: raw.expected_revision,
        revision: raw.revision,
        slug: raw.name,
        content: raw.proposal_content,
        files: raw.files,
        deleteFiles: raw.delete_files,
      });
      if ("entries" in result) {
        const entries = result.entries
          .slice(0, 20)
          .map(({ skillId, slug, name, revision, ownerProfileId, canEdit }) => ({
            skillId,
            slug,
            name,
            revision,
            ownerProfileId,
            canEdit,
          }));
        return jsonResult({
          entries,
          omitted: Math.max(0, result.entries.length - entries.length),
          nextAction:
            "Use My skills for the complete library. Read a selected skill before editing.",
        });
      }
      if ("content" in result) {
        // Whole guidance or visible omission: supporting bytes never spill into model context.
        const artifactPath = raw.artifact_path ?? "SKILL.md";
        validateSkillLibraryPath(artifactPath);
        const artifact =
          artifactPath === "SKILL.md"
            ? { path: artifactPath, content: result.content }
            : result.files.find((file) => file.path === artifactPath);
        if (!artifact) {
          throw new ToolInputError(
            "Artifact not found. Choose an exact supportFiles path from read or use My skills for the full file list.",
          );
        }
        const bytes = decodeSkillLibraryFile(artifact);
        const content = bytes.toString("utf8");
        const binary = bytes.includes(0) || !Buffer.from(content).equals(bytes);
        const included = !binary && content.length <= 16000;
        return jsonResult({
          skillId: result.entry.skillId,
          slug: result.entry.slug,
          name: result.entry.name,
          ownerProfileId: result.entry.ownerProfileId,
          canEdit: result.entry.canEdit,
          artifactPath,
          revision: result.entry.revision,
          content: included ? content : undefined,
          omissionReason: included ? undefined : binary ? "binary" : "too-large",
          contentIncluded: included,
          supportFiles: result.files
            .slice(0, 32)
            .map(({ path, executable }) => ({ path, executable: executable === true })),
          omittedFiles: Math.max(0, result.files.length - 32),
          nextAction: !included
            ? "Open My skills or use the CLI for the complete artifact. Do not overwrite unseen content."
            : "Supply expected_revision when updating. Use files for named upserts and delete_files for intentional removals; unmentioned files are preserved.",
        });
      }
      return jsonResult(result);
    },
  };
}
