import { Type } from "typebox";
import { Value } from "typebox/value";
import { SkillLibraryWorkshopSchema } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { decodeSkillLibraryFile, validateSkillLibraryPath } from "../../skills/library/bundle.js";
import { ToolInputError, type AnyAgentTool } from "./common.js";
import { textResult } from "./tool-results.js";

const personalActions = SkillLibraryWorkshopSchema.properties.action.enum.join(" | ");
const personalArguments = `Personal actions: ${personalActions}. List takes only action and target; read uses skill_id from list, not name. Update uses skill_id and expected_revision from read.`;
const workshopArguments =
  "Omit target for Workshop proposals: list returns pending proposals (limit maximum 50, default 20); read/prepare_patch/patch/update use skill_name; inspect/revise use proposal_id or name; update needs complete proposal_content.";

export function createLibrarySkillWorkshopDescriptor(
  multipleProfiles: boolean,
  workspace?: AnyAgentTool,
): Pick<AnyAgentTool, "name" | "label" | "displaySummary" | "description"> {
  return {
    name: "skill_workshop",
    label: "Skill Workshop",
    displaySummary: "Author reusable skills",
    description: `${workspace ? `${workshopArguments} Set target=personal only for personal library operations. ${workspace.description} ` : "Author skills in the requesting person's personal library. "}${personalArguments} Workshop-only actions and fields such as prepare_patch, inspect, skill_name, query, and limit are not accepted by the personal library. Personal create/update publishes a revision only when the user requests the change; personal drafts are unsupported. Describe unsolicited improvements without publishing. Read before updating; name is the slug, not the command identity. Read artifact_path for a whole text support file. On update omit name/proposal_content to preserve them; files upserts named support files, delete_files removes explicit paths. Unmentioned files and omitted executable flags are preserved. Binary or oversized reads require My skills or the CLI. Ownership is bound by the Gateway. Publication affects new sessions; activate explicitly for the next turn in this session. Sharing or transfer requires explicit user intent and current permissions.${multipleProfiles ? " This shared Gateway has personal and team libraries; sharing preserves authorship and ownership, while transfer makes a skill team managed." : ""}`,
  };
}

export function createLibrarySkillWorkshopTool(
  capability: SkillLibraryAuthoringCapability,
  workspace?: AnyAgentTool,
): AnyAgentTool {
  const schema = workspace
    ? Type.Object(
        { ...SkillLibraryWorkshopSchema.properties, target: Type.Literal("personal") },
        { additionalProperties: false },
      )
    : SkillLibraryWorkshopSchema;
  return {
    ...createLibrarySkillWorkshopDescriptor(capability.multipleProfiles, workspace),
    parameters: workspace ? Type.Union([workspace.parameters, schema]) : schema,
    execute: async (id, raw) => {
      if (workspace && (!raw || typeof raw !== "object" || !("target" in raw))) {
        capability.assertWorkspaceCurrent?.();
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
          `Invalid personal Skill Workshop arguments: ${issues.join("; ")}. ${personalArguments}${workspace ? " Omit target for Workshop proposal actions." : ""}`,
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
        return textResult(
          JSON.stringify({
            entries,
            omitted: Math.max(0, result.entries.length - entries.length),
            nextAction:
              "Use My skills for the complete library. Read a selected skill before editing.",
          }),
          {},
        );
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
        return textResult(
          JSON.stringify({
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
          }),
          {},
        );
      }
      return textResult(JSON.stringify(result), result);
    },
  };
}
