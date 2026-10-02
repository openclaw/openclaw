import type { PersistedClawCronRef } from "./cron.js";
import { readClawInventory } from "./inventory-read.js";
import type { PersistedClawMcpServerRef } from "./mcp.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import { replaceClawPackageRefExpected } from "./package-update-provenance.js";
import {
  readClawInstallRecord,
  readClawPackageRefs,
  updateClawInstallRecord,
  type PersistedClawInstall,
} from "./provenance.js";
import {
  executeClawMutationStateCommand as execute,
  type ClawMutationStateOptions,
} from "./state-mutation-write.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

export type ClawUpdateStateOptions = ClawMutationStateOptions & {
  assertForwardCurrent?: () => void;
};

async function inventory(options: ClawUpdateStateOptions) {
  options.assertCurrent?.();
  const value = await readClawInventory(options);
  options.assertCurrent?.();
  return value;
}

export async function readClawInstallRecordForUpdate(
  agentId: string,
  options: ClawUpdateStateOptions = {},
): Promise<PersistedClawInstall | undefined> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return readClawInstallRecord(agentId, options);
  }
  return (await inventory(options)).installs.find((record) => record.agentId === agentId);
}

export async function readClawPackageRefsForUpdate(
  options: ClawUpdateStateOptions & { agentId?: string } = {},
): Promise<PersistedClawPackageRef[]> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return readClawPackageRefs(options);
  }
  const refs = (await inventory(options)).packages;
  return options.agentId ? refs.filter((ref) => ref.agentId === options.agentId) : refs;
}

export async function readClawWorkspaceFilesForUpdate(
  agentId: string,
  options: ClawUpdateStateOptions = {},
): Promise<PersistedClawWorkspaceFile[]> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { readClawWorkspaceFiles } = await import("./workspace.js");
    return readClawWorkspaceFiles(agentId, options);
  }
  return (await inventory(options)).workspaceFiles.filter((ref) => ref.agentId === agentId);
}

export async function readClawMcpRefsForUpdate(
  agentId: string,
  options: ClawUpdateStateOptions = {},
): Promise<PersistedClawMcpServerRef[]> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { readClawMcpServerRefs } = await import("./mcp.js");
    return readClawMcpServerRefs(agentId, options);
  }
  return (await inventory(options)).mcpServers.filter((ref) => ref.agentId === agentId);
}

export async function readClawMcpRefsByNameForUpdate(
  name: string,
  options: ClawUpdateStateOptions = {},
): Promise<PersistedClawMcpServerRef[]> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { readClawMcpServerRefsByName } = await import("./mcp.js");
    return readClawMcpServerRefsByName(name, options);
  }
  return (await inventory(options)).mcpServers.filter((ref) => ref.name === name);
}

export async function readClawCronRefsForUpdate(
  agentId: string,
  options: ClawUpdateStateOptions = {},
): Promise<PersistedClawCronRef[]> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { readClawCronRefs } = await import("./cron.js");
    return readClawCronRefs(agentId, options);
  }
  return (await inventory(options)).cronJobs.filter((ref) => ref.agentId === agentId);
}

export async function replaceClawPackageRefForUpdate(
  expected: PersistedClawPackageRef | undefined,
  replacement: PersistedClawPackageRef | undefined,
  options: ClawUpdateStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return replaceClawPackageRefExpected(expected, replacement, options);
  }
  return execute(options, {
    type: "claws.update.replacePackageRef",
    input: { expected, replacement },
  });
}

export async function upsertClawWorkspaceFileForUpdate(
  record: PersistedClawWorkspaceFile,
  options: ClawUpdateStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { upsertClawWorkspaceFile } = await import("./workspace.js");
    return upsertClawWorkspaceFile(record, options);
  }
  return execute(options, { type: "claws.update.upsertWorkspaceFile", input: { record } });
}

export async function deleteClawWorkspaceFileForUpdate(
  agentId: string,
  path: string,
  options: ClawUpdateStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { deleteClawWorkspaceFileRecord } = await import("./workspace.js");
    return deleteClawWorkspaceFileRecord(agentId, path, options);
  }
  return execute(options, { type: "claws.update.deleteWorkspaceFile", input: { agentId, path } });
}

export async function upsertClawMcpRefForUpdate(
  record: PersistedClawMcpServerRef,
  options: ClawUpdateStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { upsertClawMcpServerRef } = await import("./mcp.js");
    return upsertClawMcpServerRef(record, options);
  }
  return execute(options, { type: "claws.update.upsertMcpRef", input: { record } });
}

export async function deleteClawMcpRefForUpdate(
  agentId: string,
  name: string,
  options: ClawUpdateStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { deleteClawMcpServerRef } = await import("./mcp.js");
    return deleteClawMcpServerRef(agentId, name, options);
  }
  return execute(options, { type: "claws.update.deleteMcpRef", input: { agentId, name } });
}

export async function upsertClawCronRefForUpdate(
  record: PersistedClawCronRef,
  options: ClawUpdateStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { upsertClawCronRef } = await import("./cron.js");
    return upsertClawCronRef(record, options);
  }
  return execute(options, { type: "claws.update.upsertCronRef", input: { record } });
}

export async function deleteClawCronRefForUpdate(
  agentId: string,
  manifestId: string,
  options: ClawUpdateStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { deleteClawCronRef } = await import("./cron.js");
    return deleteClawCronRef(agentId, manifestId, options);
  }
  return execute(options, {
    type: "claws.update.deleteCronRef",
    input: { agentId, manifestId },
  });
}

export async function persistClawInstallRecordForUpdate(
  plan: Parameters<typeof updateClawInstallRecord>[0],
  options: NonNullable<Parameters<typeof updateClawInstallRecord>[1]> & ClawUpdateStateOptions = {},
): Promise<PersistedClawInstall> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return updateClawInstallRecord(plan, options);
  }
  return execute(options, {
    type: "claws.update.persistInstall",
    input: {
      plan,
      nowMs: options.nowMs,
      expectedClaw: options.expectedClaw,
      status: options.status,
      agentConfigDigest: options.agentConfigDigest,
    },
  });
}
