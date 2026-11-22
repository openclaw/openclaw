import type {
  FsListDirResult,
  ProjectRecord,
  ProjectsAddResult,
  ProjectsListResult,
  ProjectsRegisterResult,
  ProjectsRenameParams,
  ProjectsRenameResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "../../components/confirm-dialog.ts";
import { showInputDialog } from "../../components/input-dialog.tsx";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { projectsForGateway } from "../../lib/projects.ts";
import type { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { PlaceBrowserState } from "../new-session/place-browser-state.ts";
import { roleProjectsPatch } from "./project-access.ts";

registerSessionOrganizationEnglish();

export type ProjectsOperation = "register" | "clone" | "rename" | "remove" | "access";

/** Request admission stays synchronous while Solid projects this page's presentation. */
export class ProjectsModel {
  records: ProjectRecord[] = [];
  listLoaded = false;
  listRead: { result: Promise<void> } = { result: Promise.resolve() };
  error: string | null = null;
  operation: ProjectsOperation | null = null;
  query = "";
  selectedId: string | null = null;
  browserOpen = false;
  /** The switch a role-access write is saving, shown until the write settles. */
  pendingAccess: { role: string; projectId: string; enabled: boolean } | null = null;
  readonly browser: PlaceBrowserState;
  gateway!: ReturnType<typeof useGatewayPage>;
  private presentationLifetime = Promise.withResolvers<void>();
  private readonly listRequest = createPageRequest(() => this.update({}), {
    task: (scope: GatewayConnectionScope, { signal }) =>
      scope.client.request<ProjectsListResult>("projects.list", {}, { signal }),
    onComplete: (result) => {
      this.records = result.projects.toSorted((left, right) =>
        left.displayName.localeCompare(right.displayName),
      );
      this.listLoaded = true;
      if (this.selectedId && !this.records.some((project) => project.id === this.selectedId)) {
        this.selectedId = null;
      }
    },
    onError: (error) => {
      this.error = formatUiError(error);
    },
  });

  constructor(
    private readonly getContext: () => ApplicationContext,
    private readonly publish: () => void,
  ) {
    this.browser = new PlaceBrowserState((path) => {
      const scope = this.gateway.capture();
      if (!scope || !this.browserOpen) {
        return Promise.reject(new Error(t("newSession.browserLoadFailed")));
      }
      return scope.client.request<FsListDirResult>("fs.listDir", path ? { path } : {});
    }, publish);
  }

  get context() {
    return this.getContext();
  }

  update(
    values: Partial<
      Pick<
        ProjectsModel,
        | "records"
        | "listLoaded"
        | "error"
        | "operation"
        | "query"
        | "selectedId"
        | "browserOpen"
        | "pendingAccess"
      >
    >,
  ) {
    Object.assign(this, values);
    this.publish();
  }

  invalidateRequests() {
    // Gateway binding retires the read and any open browser before a replacement scope publishes.
    this.presentationLifetime.resolve();
    this.presentationLifetime = Promise.withResolvers<void>();
    this.listRequest.cancel();
    this.browser.reset();
    this.update({ operation: null, pendingAccess: null, browserOpen: false });
  }

  get retired() {
    return this.presentationLifetime.promise;
  }

  get operatorAccess() {
    return readGatewayOperatorAccess(this.context.gateway.snapshot);
  }

  get selected(): ProjectRecord | undefined {
    return this.records.find((project) => project.id === this.selectedId);
  }

  /** Writes to `gateway.roles` go through the shared config editor; read-only configs refuse them. */
  get canEditAccess(): boolean {
    return (
      this.operatorAccess.canAdmin &&
      this.context.runtimeConfig.canPatch !== false &&
      !this.context.config.current.readOnlyConfig
    );
  }

  get canClone(): boolean {
    return canCallGatewayMethod(this.context.gateway.snapshot, "projects.add", "operator.write");
  }

  /** `replace` retires an in-flight read that may predate a change this page just made. */
  async load(options: { preserveError?: boolean; replace?: boolean } = {}) {
    const scope = this.gateway.capture();
    if (!scope || (this.listRequest.pending && !options.replace)) {
      return;
    }
    if (!options.preserveError) {
      this.error = null;
    }
    if (!canCallGatewayMethod(this.context.gateway.snapshot, "projects.list", "operator.read")) {
      this.update({ records: [], listLoaded: true });
      return;
    }
    const pending = this.listRequest.run(scope);
    this.listRead = { result: Promise.race([pending, this.retired]) };
    this.publish();
    await pending;
  }

  select(projectId: string | null) {
    this.update({ selectedId: projectId, error: null });
  }

  private admit(operation: ProjectsOperation) {
    const scope = this.gateway.capture();
    if (!scope || !this.operatorAccess.canAdmin || this.operation !== null) {
      return null;
    }
    this.update({ operation, error: null });
    return scope;
  }

  /** Finishes an admitted operation: settles its state and rereads the list it changed. */
  private async settle(scope: GatewayConnectionScope, changed: boolean, error?: unknown) {
    if (!this.gateway.isCurrent(scope)) {
      return;
    }
    this.update({
      operation: null,
      pendingAccess: null,
      ...(error === undefined ? {} : { error: formatUiError(error) }),
    });
    if (changed) {
      // New Session reads the shared catalog; retire it so the change shows there too.
      void projectsForGateway(this.context.gateway).refresh(true);
      await this.load({ preserveError: true, replace: true });
    }
  }

  openBrowser() {
    if (!this.operatorAccess.canAdmin || this.operation !== null || !this.gateway.connected) {
      return;
    }
    const agents = this.context.agents.state.agentsList;
    const workspace = agents?.agents.find((agent) => agent.id === agents.defaultId)?.workspace;
    this.update({ browserOpen: true });
    void this.browser.navigate(workspace || undefined, "initial");
  }

  closeBrowser() {
    // "Use this folder" closes the browser as it registers; keep it open to show the outcome.
    if (this.operation === "register") {
      return;
    }
    this.browser.reset();
    this.update({ browserOpen: false });
  }

  async registerFolder(path: string) {
    const scope = this.admit("register");
    if (!scope) {
      return;
    }
    this.browser.error = null;
    // Retire the preceding directory error so a registration failure shows by itself.
    this.browser.readCompletion = null;
    try {
      const project = await scope.client.request<ProjectsRegisterResult>("projects.register", {
        path,
      });
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      this.browser.reset();
      this.update({ browserOpen: false, selectedId: project.id });
      await this.settle(scope, true);
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.browser.error = formatUiError(error);
      }
      await this.settle(scope, false);
    }
  }

  /**
   * Runs an admitted dialog-driven operation. Dialog preparation and the request share
   * one lifecycle, so any failure is shown and the page leaves its busy state.
   */
  private async run(
    operation: ProjectsOperation,
    task: (scope: GatewayConnectionScope) => Promise<boolean>,
  ) {
    const scope = this.admit(operation);
    if (!scope) {
      return;
    }
    try {
      await this.settle(scope, await task(scope));
    } catch (error) {
      await this.settle(scope, false, error);
    }
  }

  cloneFromGitHub() {
    return this.run("clone", async (scope) => {
      let cloned: ProjectsAddResult | undefined;
      await showInputDialog({
        title: t("projectsPage.cloneTitle"),
        label: t("projectsPage.cloneLabel"),
        submitLabel: t("projectsPage.cloneSubmit"),
        requireValue: true,
        gateway: this.context.gateway,
        canSubmit: () => this.gateway.isCurrent(scope),
        submit: async (gitUrl) => {
          try {
            cloned = await scope.client.request<ProjectsAddResult>("projects.add", { gitUrl });
            return null;
          } catch (error) {
            return formatUiError(error);
          }
        },
      });
      if (cloned && this.gateway.isCurrent(scope)) {
        this.update({ selectedId: cloned.id });
      }
      return Boolean(cloned);
    });
  }

  rename(project: ProjectRecord) {
    return this.run("rename", async (scope) => {
      let renamed = false;
      await showInputDialog({
        title: t("projectsPage.renameTitle"),
        label: t("projectsPage.renameLabel"),
        defaultValue: project.displayName,
        submitLabel: t("projectsPage.rename"),
        requireValue: true,
        requireChange: true,
        gateway: this.context.gateway,
        canSubmit: () => this.gateway.isCurrent(scope),
        submit: async (name) => {
          try {
            const params: ProjectsRenameParams = { projectId: project.id, name };
            await scope.client.request<ProjectsRenameResult>("projects.rename", params);
            renamed = true;
            return null;
          } catch (error) {
            return formatUiError(error);
          }
        },
      });
      return renamed;
    });
  }

  remove(project: ProjectRecord) {
    return this.run("remove", async (scope) => {
      const title = t("projectsPage.removeTitle", { name: project.displayName });
      const choice =
        project.source === "cloned"
          ? await showConfirmChoiceDialog({
              title,
              message: t("projectsPage.removeClonedBody"),
              confirmLabel: t("projectsPage.remove"),
              alternativeLabel: t("projectsPage.removeDeleteCheckout"),
              danger: true,
            })
          : (await showConfirmDialog({
                title,
                message: t("projectsPage.removeBody"),
                confirmLabel: t("projectsPage.remove"),
                danger: true,
              }))
            ? "confirm"
            : null;
      if (!choice || !this.gateway.isCurrent(scope)) {
        return false;
      }
      // The Gateway refuses to delete a checkout that sessions or worktrees still reference.
      await scope.client.request("projects.remove", {
        id: project.id,
        ...(choice === "alternative" ? { deleteCheckout: true } : {}),
      });
      if (this.gateway.isCurrent(scope)) {
        this.update({ selectedId: null });
      }
      return true;
    });
  }

  async setRoleAccess(role: string, project: ProjectRecord, enabled: boolean) {
    if (!this.canEditAccess) {
      return;
    }
    const scope = this.admit("access");
    if (!scope) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    this.update({ pendingAccess: { role, projectId: project.id, enabled } });
    try {
      const patched = await runtimeConfig.patchFromSnapshot((config) => {
        const built = roleProjectsPatch(config, role, project.id, enabled);
        return "error" in built
          ? {
              error: t(
                built.error === "missing"
                  ? "projectsPage.accessRoleMissing"
                  : "projectsPage.accessAllProjects",
                { role },
              ),
            }
          : { options: { ...built.options, canDispatch: () => this.gateway.isCurrent(scope) } };
      });
      await this.settle(
        scope,
        false,
        patched
          ? undefined
          : (runtimeConfig.state.lastError ?? t("projectsPage.accessSaveFailed", { role })),
      );
    } catch (error) {
      await this.settle(scope, false, error);
    }
  }
}
