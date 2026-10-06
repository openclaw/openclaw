import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

type TemplateOperation = Extract<
  keyof OpenClawStateWorkerOperations,
  `worktrees.templates.${string}`
>;

async function runTemplateCommand<Key extends TemplateOperation>(
  env: NodeJS.ProcessEnv,
  command: { type: Key; input: OpenClawStateWorkerOperations[Key]["input"] },
  commitGuard?: () => void,
): Promise<OpenClawStateWorkerOperations[Key]["output"]> {
  const context = captureOpenClawStateWorkerContext({ env });
  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
  try {
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute(command),
      {
        assertCurrent: commitGuard,
        createAdmission: (operation) => {
          settled = operation.settled;
          return {
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((_request, grant) => {
              context.admission.assertCurrent();
              commitGuard?.();
              grant();
            }),
          };
        },
      },
    );
    context.admission.assertCurrent();
    commitGuard?.();
    return result;
  } finally {
    // Keep filesystem cleanup behind the accepted write's native settlement.
    await settled;
  }
}

export function readTemplateAsync(
  env: NodeJS.ProcessEnv,
  cacheKey: string,
  commitGuard?: () => void,
): Promise<WorktreeTemplateRecord | undefined> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.read", input: { cacheKey } },
    commitGuard,
  );
}

export function hasTemplatesAsync(
  env: NodeJS.ProcessEnv,
  commitGuard?: () => void,
): Promise<boolean> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.has", input: undefined },
    commitGuard,
  );
}

export function listTemplatesAsync(
  env: NodeJS.ProcessEnv,
  commitGuard?: () => void,
): Promise<WorktreeTemplateRecord[]> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.list", input: undefined },
    commitGuard,
  );
}

export function reserveTemplateAsync(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord & { status: "preparing" },
  commitGuard: () => void,
): Promise<void> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.reserve", input: record },
    commitGuard,
  );
}

export function markTemplateReadyAsync(
  env: NodeJS.ProcessEnv,
  id: string,
  now: number,
  commitGuard: () => void,
): Promise<boolean> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.ready", input: { id, now } },
    commitGuard,
  );
}

export function touchTemplateAsync(
  env: NodeJS.ProcessEnv,
  id: string,
  now: number,
  commitGuard: () => void,
): Promise<boolean> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.touch", input: { id, now } },
    commitGuard,
  );
}

export function deleteTemplateAsync(
  env: NodeJS.ProcessEnv,
  id: string,
  commitGuard: () => void,
): Promise<boolean> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.delete", input: { id } },
    commitGuard,
  );
}
