import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace-bootstrap-policy.js";
import { readCanonicalWorkspaceStateSnapshot } from "../agents/workspace-state-read.js";
import {
  mergeWorkspaceSetupState,
  replaceWorkspaceAttestation,
  rollbackWorkspaceBootstrapSeed,
  type WorkspaceSetupState,
} from "../agents/workspace-state-store.js";
import { readTemplateInventory } from "./inventory-read.js";
import { readTemplatePackageRefs } from "./provenance.js";
import {
  executeTemplateMutationStateCommand as execute,
  type TemplateMutationStateOptions,
} from "./state-mutation-write.js";

export type TemplateAddStateOptions = TemplateMutationStateOptions;

export async function readTemplatePackageRefsForAdd(
  options: NonNullable<Parameters<typeof readTemplatePackageRefs>[0]> &
    TemplateAddStateOptions = {},
): Promise<ReturnType<typeof readTemplatePackageRefs>> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return readTemplatePackageRefs(options);
  }
  options.assertCurrent?.();
  const { packages: refs } = await readTemplateInventory(options);
  options.assertCurrent?.();
  return refs.filter(
    (ref) =>
      (options.agentId === undefined || ref.agentId === options.agentId) &&
      (options.kind === undefined || ref.kind === options.kind) &&
      (options.source === undefined || ref.source === options.source) &&
      (options.ref === undefined || ref.ref === options.ref) &&
      (options.version === undefined || ref.version === options.version) &&
      (options.integrity === undefined || ref.integrity === options.integrity) &&
      (options.status === undefined || ref.status === options.status),
  );
}

export async function mergeWorkspaceBootstrapSetupStateForAdd(
  workspaceDir: string,
  bootstrapSeededAt: string,
  bootstrapSha256: string,
  nowMs: number,
  options: TemplateAddStateOptions = {},
): Promise<WorkspaceSetupState> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const attestedAtMs = Date.now();
    const snapshot = await readCanonicalWorkspaceStateSnapshot(workspaceDir, options);
    const generatedHashes = new Map(snapshot.attestation?.generatedHashes);
    generatedHashes.set(DEFAULT_BOOTSTRAP_FILENAME, bootstrapSha256);
    await replaceWorkspaceAttestation({
      ...options,
      workspaceDir,
      attestedAtMs,
      generatedHashes,
    });
    return mergeWorkspaceSetupState(workspaceDir, { bootstrapSeededAt }, nowMs, options);
  }
  return execute(options, {
    type: "templates.add.mergeBootstrapSetupState",
    input: { workspaceDir, bootstrapSeededAt, bootstrapSha256, nowMs },
  });
}

export async function rollbackWorkspaceBootstrapSeedForAdd(
  workspaceDir: string,
  bootstrapSeededAt: string,
  options: TemplateAddStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    await options.prepareEffect?.();
    options.assertCurrent?.();
    return rollbackWorkspaceBootstrapSeed(workspaceDir, bootstrapSeededAt, options);
  }
  return execute(options, {
    type: "templates.add.rollbackBootstrapSeed",
    input: { workspaceDir, bootstrapSeededAt },
  });
}
