import { join } from "node:path";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type {
  ClawOpenClawProfile,
  ClawSourceIdentity,
  ClawWorkspaceSourceSnapshot,
} from "./types.js";

export async function makeProvenancePlan(
  root: string,
  manifestValue: unknown,
  options: {
    workspace?: string;
    openClawProfile?: ClawOpenClawProfile;
    packageBootstrap?: ClawWorkspaceSourceSnapshot;
    packagePreflight?: NonNullable<
      Parameters<typeof buildClawAddPlan>[0]["context"]
    >["packagePreflight"];
  } = {},
) {
  const parsed = parseClawManifest(manifestValue);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 123,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    openClawProfile: options.openClawProfile,
    packageBootstrap: options.packageBootstrap,
    source,
    context: {
      workspace: options.workspace ?? join(root, "workspace-worker"),
      ...(options.packagePreflight ? { packagePreflight: options.packagePreflight } : {}),
    },
  });
  return { root, plan };
}

export function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}
