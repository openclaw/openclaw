import { Type } from "typebox";
import { SkillLibraryWorkshopSchema } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import type { SessionToolDiscoveryPresentation } from "../../config/sessions/tool-discovery.types.js";
import type { AnyAgentTool } from "./common.js";

const personalActions = SkillLibraryWorkshopSchema.properties.action.enum.join(" | ");
export const personalWorkshopArguments = `Personal actions: ${personalActions}. List takes only action and target; read uses skill_id from list, not name. Update uses skill_id and expected_revision from read.`;

/** Builds only provider-visible data; it never receives or constructs an execution capability. */
export function createLibrarySkillWorkshopDeclaration(
  presentation: NonNullable<SessionToolDiscoveryPresentation["workshop"]>,
  workspace?: Pick<AnyAgentTool, "description" | "parameters">,
): Pick<AnyAgentTool, "description" | "parameters"> {
  const schema = workspace
    ? Type.Object(
        { ...SkillLibraryWorkshopSchema.properties, target: Type.Literal("personal") },
        { additionalProperties: false },
      )
    : SkillLibraryWorkshopSchema;
  return {
    description: `${workspace ? `Omit target for your learned (Workshop) skills. Set target=personal only for personal library operations. ${workspace.description} ` : "Author skills in the requesting person's personal library. "}${personalWorkshopArguments} Workshop-only actions and fields such as view, patch, write_file, old_text, and file_path are not accepted by the personal library. Personal create/update publishes a revision only when the user requests the change; personal drafts are unsupported. Describe unsolicited improvements without publishing. Read before updating; name is the slug, not the command identity. Read artifact_path for a whole text support file. On update omit name/proposal_content to preserve them; files upserts named support files, delete_files removes explicit paths. Unmentioned files and omitted executable flags are preserved. Binary or oversized reads require My skills or the CLI. Ownership is bound by the Gateway. Publication affects new sessions; activate explicitly for the next turn in this session. Sharing or transfer requires explicit user intent and current permissions.${presentation.multipleProfiles ? " This shared Gateway has personal and team libraries; sharing preserves authorship and ownership, while transfer makes a skill team managed." : ""}`,
    parameters: workspace ? Type.Union([workspace.parameters, schema]) : schema,
  };
}
