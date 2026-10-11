import type {
  WorktreeRecord,
  WorktreesBranchesResult,
  WorktreesListResult,
  WorktreesRemoveResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import type { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { createManagedWorktree } from "../../lib/worktrees/create-worktree.ts";
import { gcManagedWorktrees } from "../../lib/worktrees/gc-worktrees.ts";

/** Request admission stays synchronous while Solid projects this page's presentation. */
export class WorktreesModel {
  records: WorktreeRecord[] = [];
  error: string | null = null;
  operation: "row" | "create" | "gc" | null = null;
  createOpen = false;
  createRepoRoot = "";
  createName = "";
  createBaseRef = "";
  createBranches: string[] = [];
  gateway!: ReturnType<typeof useGatewayPage>;
  private listRequest: AbortController | null = null;
  private branchesRequest: AbortController | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly getContext: () => ApplicationContext) {}

  get context() {
    return this.getContext();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(
    values: Partial<
      Pick<
        WorktreesModel,
        | "records"
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
    for (const listener of this.listeners) {
      listener();
    }
  }

  invalidateRequests() {
    this.listRequest?.abort();
    this.branchesRequest?.abort();
    this.listRequest = this.branchesRequest = null;
    this.update({ operation: null });
  }

  get loading() {
    return this.operation === "gc" || this.listRequest !== null;
  }

  get operationPending() {
    return this.loading || this.operation !== null;
  }

  get operatorAccess() {
    return readGatewayOperatorAccess(this.context.gateway.snapshot);
  }

  async load(options: { preserveError?: boolean } = {}) {
    const scope = this.gateway.capture();
    if (!scope || this.operation !== null || this.listRequest) {
      return;
    }
    const request = new AbortController();
    this.listRequest = request;
    this.update(options.preserveError ? {} : { error: null });
    try {
      const result = await scope.client.request<WorktreesListResult>(
        "worktrees.list",
        {},
        {
          signal: request.signal,
        },
      );
      if (this.gateway.isCurrent(scope) && this.listRequest === request) {
        this.update({
          records: result.worktrees.toSorted((a, b) => b.lastActiveAt - a.lastActiveAt),
        });
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && this.listRequest === request) {
        this.update({ error: formatUiError(error) });
      }
    } finally {
      if (this.listRequest === request) {
        this.listRequest = null;
        this.update({});
      }
    }
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
    await this.runOperation(scope, () =>
      gcManagedWorktrees(scope.client, () => this.gateway.isCurrent(scope)),
    );
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
    this.branchesRequest?.abort();
    this.branchesRequest = null;
    const scope = this.gateway.capture();
    const repoRoot = this.createRepoRoot.trim();
    if (!scope || !repoRoot || !this.operatorAccess.canWrite) {
      this.update({ createBranches: [] });
      return;
    }
    const request = new AbortController();
    this.branchesRequest = request;
    try {
      const result = await scope.client.request<WorktreesBranchesResult>(
        "worktrees.branches",
        { repoRoot },
        {
          signal: request.signal,
        },
      );
      if (this.gateway.isCurrent(scope) && this.branchesRequest === request) {
        this.update({ createBranches: result.branches.map((branch) => branch.name) });
      }
    } catch {
      if (this.gateway.isCurrent(scope) && this.branchesRequest === request) {
        this.update({ createBranches: [] });
      }
    } finally {
      if (this.branchesRequest === request) {
        this.branchesRequest = null;
      }
    }
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
