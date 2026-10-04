import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerOperations,
} from "../../state/worker-operation-registry.js";
import {
  deleteTemplate,
  hasTemplates,
  listTemplates,
  markTemplateReady,
  readTemplate,
  reserveTemplate,
  touchTemplate,
} from "./template-registry.js";

function worktreeTemplateMutation<Input, Output>(
  operationLabel: string,
  mutate: (env: NodeJS.ProcessEnv, input: Input, commitGuard: () => void) => Output,
) {
  return (input: Input, context: WorkerOperationContext): Output => {
    const database = context.open();
    const options = context.stateOptions();
    return runOpenClawStateWriteTransaction(
      () => {
        const result = mutate(options.env, input, () => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        });
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { ...options, database },
      { operationLabel },
    );
  };
}

export const worktreeTemplateOperations = {
  "worktrees.templates.read": ({ cacheKey }: { cacheKey: string }, { stateOptions }) =>
    readTemplate(stateOptions().env, cacheKey),
  "worktrees.templates.has": (_input: undefined, { stateOptions }) =>
    hasTemplates(stateOptions().env),
  "worktrees.templates.list": (_input: undefined, { stateOptions }) =>
    listTemplates(stateOptions().env),
  "worktrees.templates.reserve": worktreeTemplateMutation(
    "worktrees.templates.reserve",
    reserveTemplate,
  ),
  "worktrees.templates.ready": worktreeTemplateMutation(
    "worktrees.templates.ready",
    (env, { id, now }: { id: string; now: number }, commitGuard) =>
      markTemplateReady(env, id, now, commitGuard),
  ),
  "worktrees.templates.touch": worktreeTemplateMutation(
    "worktrees.templates.touch",
    (env, { id, now }: { id: string; now: number }, commitGuard) =>
      touchTemplate(env, id, now, commitGuard),
  ),
  "worktrees.templates.delete": worktreeTemplateMutation(
    "worktrees.templates.delete",
    (env, { id }: { id: string }, commitGuard) => deleteTemplate(env, id, commitGuard),
  ),
} satisfies WorkerOperationHandlers;

export type WorktreeTemplateWorkerOperations = WorkerOperations<typeof worktreeTemplateOperations>;
