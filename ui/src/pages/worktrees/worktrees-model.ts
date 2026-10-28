import { sleepWithAbort } from "@openclaw/retry";
import type {
  WorktreeRecord,
  WorktreesBranchesResult,
  WorktreesGcResult,
  WorktreesListResult,
  WorktreesRemoveResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import type { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { createManagedWorktree } from "../../lib/worktrees/create-worktree.ts";

registerSessionOrganizationEnglish();

/** Request admission stays synchronous while Solid projects this page's presentation. */
export class WorktreesModel {
  records: WorktreeRecord[] = [];
  listLoaded = false;
  listRead: { result: Promise<void> } = { result: Promise.resolve() };
  private presentationLifetime = Promise.withResolvers<void>();
  error: string | null = null;
  operation: "row" | "create" | "gc" | null = null;
  createOpen = false;
  createRepoRoot = "";
  createName = "";
  createBaseRef = "";
  createBranches: string[] = [];
  gateway!: ReturnType<typeof useGatewayPage>;
  private readonly listRequest = createPageRequest(() => this.update({}), {
    task: (scope: GatewayConnectionScope, { signal }) =>
      scope.client.request<WorktreesListResult>("worktrees.list", {}, { signal }),
    onComplete: (result) => {
      this.records = result.worktrees.toSorted((a, b) => b.lastActiveAt - a.lastActiveAt);
      this.listLoaded = true;
    },
    onError: (error) => {
      this.error = formatUiError(error);
    },
  });
  private readonly branchesRequest = createPageRequest(() => this.update({}), {
    task: ({ scope, repoRoot }: { scope: GatewayConnectionScope; repoRoot: string }, { signal }) =>
      scope.client.request<WorktreesBranchesResult>("worktrees.branches", { repoRoot }, { signal }),
    onComplete: (result) => {
      this.createBranches = result.branches.map((branch) => branch.name);
    },
    onError: () => {
      this.createBranches = [];
    },
  });

  constructor(
    private readonly getContext: () => ApplicationContext,
    private readonly publish: () => void,
  ) {}

  get context() {
    return this.getContext();
  }

  update(
    values: Partial<
      Pick<
        WorktreesModel,
        | "records"
        | "listLoaded"
        | "error"
        | "operation"
        | "createOpen"
        | "createRepoRoot"
        | "createName"
        | "createBaseRef"
        | "createBranches"
      >
    >,
  ) {
    Object.assign(this, values);
    this.publish();
  }

  invalidateRequests() {
    // Gateway binding retires both reads before a replacement scope can publish.
    this.presentationLifetime.resolve();
    this.presentationLifetime = Promise.withResolvers<void>();
    this.listRequest.cancel();
    this.branchesRequest.cancel();
    this.update({ operation: null });
  }

  get retired() {
    return this.presentationLifetime.promise;
  }

  get loading() {
    return this.operation === "gc" || this.listRequest.pending;
  }

  get operationPending() {
    return this.loading || this.operation !== null;
  }

  get operatorAccess() {
    return readGatewayOperatorAccess(this.context.gateway.snapshot);
  }

  async load(options: { preserveError?: boolean } = {}) {
    const scope = this.gateway.capture();
    if (!scope || this.operation !== null || this.listRequest.pending) {
      return;
    }
    if (!options.preserveError) {
      this.error = null;
    }
    const pending = this.listRequest.run(scope);
    this.listRead = { result: Promise.race([pending, this.retired]) };
    this.publish();
    await pending;
  }

  private async runOperation(scope: GatewayConnectionScope, action: () => Promise<unknown>) {
    this.update({ error: null });
    try {
      await action();
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.update({ error: formatUiError(error) });
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.update({ operation: null });
        await this.load({ preserveError: true });
      }
    }
  }

  async removeWorktree(record: WorktreeRecord) {
    const scope = this.gateway.capture();
    if (!scope || !this.operatorAccess.canAdmin || this.operationPending) {
      return;
    }
    if (
      !(await showConfirmDialog({
        message: t("worktrees.confirmDelete", { name: record.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      })) ||
      !this.gateway.isCurrent(scope) ||
      !this.operatorAccess.canAdmin ||
      this.operationPending
    ) {
      return;
    }
    // The force retry belongs to the same Gateway epoch as the initial removal.
    this.update({ operation: "row" });
    await this.runOperation(scope, async () => {
      const result = await scope.client.request<WorktreesRemoveResult>("worktrees.remove", {
        id: record.id,
      });
      if (!this.gateway.isCurrent(scope) || result.removed) {
        return;
      }
      const reason = result.snapshotError ?? "";
      const force = await showConfirmDialog({
        message: t("worktrees.confirmForceDelete", { error: reason }),
        confirmLabel: t("common.delete"),
        danger: true,
      });
      if (!this.gateway.isCurrent(scope) || !this.operatorAccess.canAdmin) {
        return;
      }
      if (!force) {
        this.update({ error: reason || null });
        return;
      }
      const forced = await scope.client.request<WorktreesRemoveResult>("worktrees.remove", {
        id: record.id,
        force: true,
      });
      if (this.gateway.isCurrent(scope)) {
        this.update({ error: forced.snapshotError ?? null });
      }
    });
  }

  async restore(record: WorktreeRecord) {
    const scope = this.gateway.capture();
    if (!scope || !this.operatorAccess.canAdmin || this.operationPending) {
      return;
    }
    this.update({ operation: "row" });
    await this.runOperation(scope, () =>
      scope.client.request("worktrees.restore", { id: record.id }),
    );
  }

  async gc() {
    const scope = this.gateway.capture();
    if (!scope || !this.operatorAccess.canAdmin || this.operationPending) {
      return;
    }
    this.update({ operation: "gc" });
    await this.runOperation(scope, async () => {
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      let result = await scope.client.request<WorktreesGcResult>("worktrees.gc", {});
      const jobId = result.jobId;
      while (result.state === "queued" || result.state === "running") {
        if (!this.gateway.isCurrent(scope)) {
          return;
        }
        if (!jobId) {
          throw new Error(t("sessionsView.deletePreservedReasons.cleanup-failed"));
        }
        await sleepWithAbort(1_000);
        if (!this.gateway.isCurrent(scope)) {
          return;
        }
        result = await scope.client.request<WorktreesGcResult>("worktrees.gc", { jobId });
      }
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      if (result.state === "failed" || result.outcome === "partial") {
        throw new Error(
          result.error ||
            result.issues?.map((issue) => issue.reason).join("; ") ||
            t("sessionsView.deletePreservedReasons.cleanup-failed"),
        );
      }
    });
  }

  toggleCreate() {
    if (!this.operatorAccess.canAdmin || this.operation === "create") {
      return;
    }
    this.update({ createOpen: !this.createOpen });
    if (this.createOpen && !this.createRepoRoot) {
      const agents = this.context.agents.state.agentsList;
      const defaultAgent = agents?.agents.find((agent) => agent.id === agents.defaultId);
      this.update({ createRepoRoot: defaultAgent?.workspace ?? "" });
      void this.loadCreateBranches();
    }
  }

  async loadCreateBranches() {
    this.branchesRequest.cancel();
    const scope = this.gateway.capture();
    const repoRoot = this.createRepoRoot.trim();
    if (!scope || !repoRoot || !this.operatorAccess.canWrite) {
      this.update({ createBranches: [] });
      return;
    }
    await this.branchesRequest.run({ scope, repoRoot });
  }

  async createWorktree() {
    const scope = this.gateway.capture();
    const repoRoot = this.createRepoRoot.trim();
    if (!scope || !this.operatorAccess.canAdmin || !repoRoot || this.operationPending) {
      return;
    }
    this.update({ operation: "create" });
    await this.runOperation(scope, async () => {
      await createManagedWorktree(scope.client, {
        repoRoot,
        name: this.createName,
        baseRef: this.createBaseRef,
      });
      if (this.gateway.isCurrent(scope)) {
        this.update({ createOpen: false, createName: "" });
      }
    });
  }
}
