import {
  mergeWorkspaceSetupState,
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
  nowMs: number,
  options: TemplateAddStateOptions = {},
): Promise<WorkspaceSetupState> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const next = { bootstrapSeededAt, bootstrapSupplied: true } as const;
    return mergeWorkspaceSetupState(workspaceDir, next, nowMs, options);
  }
  return execute(options, {
    type: "templates.add.mergeBootstrapSetupState",
    input: { workspaceDir, bootstrapSeededAt, nowMs },
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
