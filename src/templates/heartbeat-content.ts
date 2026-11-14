import { CRON_JOB_SCRATCH_MAX_BYTES } from "../cron/scratch-contract.js";
import { Utf8InputError, decodeUtf8Input } from "../infra/utf8-input.js";
import type { TemplateManifest } from "./schema.js";
import type { TemplateAddPlanAction } from "./types.js";

/**
 * Add converts exactly this workspace destination into portable heartbeat scratch, so the same
 * exact name decides which sources authoring must check. A path that only collides with it
 * (`HEARTBEAT.md/notes.md`) or only case-folds to it (`heartbeat.md`) stays an ordinary file.
 */
export const TEMPLATE_HEARTBEAT_DESTINATION = "HEARTBEAT.md";

export type TemplateHeartbeatContentFailure = {
  code: "workspace_heartbeat_too_large" | "workspace_heartbeat_invalid_utf8";
  message: string;
};

/** Whether a planned action is the workspace file Add converts into heartbeat scratch. */
export function isTemplateHeartbeatAction(action: TemplateAddPlanAction): boolean {
  return action.kind === "workspaceFile" && action.id === TEMPLATE_HEARTBEAT_DESTINATION;
}

/** Template sources whose destination becomes portable heartbeat scratch, keyed by manifest path. */
export function templateHeartbeatSources(manifest: TemplateManifest): Map<string, string> {
  const sources = new Map<string, string>();
  const declared = manifest.workspace.bootstrapFiles[TEMPLATE_HEARTBEAT_DESTINATION];
  if (declared) {
    sources.set(declared.source, `$.workspace.bootstrapFiles.${TEMPLATE_HEARTBEAT_DESTINATION}`);
  }
  manifest.workspace.files.forEach((file, index) => {
    if (!sources.has(file.source) && file.path === TEMPLATE_HEARTBEAT_DESTINATION) {
      sources.set(file.source, `$.workspace.files[${index}]`);
    }
  });
  return sources;
}

/**
 * Add stores mapped HEARTBEAT.md content as bounded cron scratch, so authoring rejects the
 * content Add could never store instead of publishing a Template nobody can add.
 */
export function templateHeartbeatContentFailure(
  bytes: Buffer,
): TemplateHeartbeatContentFailure | undefined {
  let text: string;
  try {
    text = decodeUtf8Input(bytes, TEMPLATE_HEARTBEAT_DESTINATION);
  } catch (error) {
    if (!(error instanceof Utf8InputError)) {
      throw error;
    }
    return {
      code: "workspace_heartbeat_invalid_utf8",
      message: `${TEMPLATE_HEARTBEAT_DESTINATION} must be valid UTF-8 text to become heartbeat scratch.`,
    };
  }
  const sizeBytes = Buffer.byteLength(text, "utf8");
  if (sizeBytes > CRON_JOB_SCRATCH_MAX_BYTES) {
    return {
      code: "workspace_heartbeat_too_large",
      message: `${TEMPLATE_HEARTBEAT_DESTINATION} exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes (${sizeBytes} bytes provided).`,
    };
  }
  return undefined;
}
