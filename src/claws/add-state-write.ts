import {
  mergeWorkspaceSetupState,
  type WorkspaceSetupState,
} from "../agents/workspace-state-store.js";
import { readClawInventory } from "./inventory-read.js";
import { readClawPackageRefs } from "./provenance.js";
import {
  executeClawMutationStateCommand as execute,
  type ClawMutationStateOptions,
} from "./state-mutation-write.js";

export type ClawAddStateOptions = ClawMutationStateOptions;

export async function readClawPackageRefsForAdd(
  options: NonNullable<Parameters<typeof readClawPackageRefs>[0]> & ClawAddStateOptions = {},
): Promise<ReturnType<typeof readClawPackageRefs>> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return readClawPackageRefs(options);
  }
  options.assertCurrent?.();
  const { packages: refs } = await readClawInventory(options);
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
  options: ClawAddStateOptions = {},
): Promise<WorkspaceSetupState> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return mergeWorkspaceSetupState(workspaceDir, { bootstrapSeededAt }, nowMs, options);
  }
  return execute(options, {
    type: "claws.add.mergeBootstrapSetupState",
    input: { workspaceDir, bootstrapSeededAt, nowMs },
  });
}
