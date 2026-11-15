import { action, createMemo, createOptimistic, createSignal, onSettled, Show } from "solid-js";
import { pathForTemplateCatalogEntry } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { FilePreviewModal } from "../../components/file-preview-modal.tsx";
import { ModalDialog } from "../../components/modal-dialog.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { registerTemplatesEnglish } from "../../i18n/locales/en-templates.ts";
import { formatUiError, UserFacingError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { loadPluginCatalog } from "../../lib/plugins/index.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { addTemplateAgent } from "./templates-add-agent.ts";
import {
  readTemplateAddReviewPlan,
  readTemplateDetail,
  readTemplatePreview,
  type TemplateCatalogDetail,
  type TemplateCatalogEntry,
  type TemplateCatalogSource,
  type TemplateAddReviewPlan,
} from "./templates-catalog-client.ts";
import type { TemplatesCatalogViewProps } from "./templates-catalog-view-props.ts";
import { TemplatesCatalogView } from "./templates-catalog-view.tsx";
import { TemplatesExplore } from "./templates-explore.tsx";

registerEnglishCatalog(registerTemplatesEnglish);

type TemplatesDialogProps = {
  onClose?: () => void;
  initialPackageName?: string;
  initialVersion?: string;
  modal?: boolean;
};

class TemplatesCatalogModel {
  selected: TemplateCatalogEntry | null = null;
  detail: TemplateCatalogDetail | null = null;
  preview: {
    kind: "instruction" | "skill";
    name: string;
    content: string | null;
    request: Promise<void>;
  } | null = null;
  installedPluginPackages: ReadonlySet<string> = new Set();
  addError: string | null = null;
  applying = false;
  reviewing = false;
  consentWarning: string | null = null;
  reviewPlan: TemplateAddReviewPlan | null = null;
  private riskAcknowledged = false;
  private preparedPlan: TemplateAddReviewPlan | null = null;
  gateway!: ReturnType<typeof useGatewayPage>;
  disposed = false;

  constructor(
    readonly context: ApplicationContext,
    readonly props: TemplatesDialogProps,
    readonly presentDetailRequest: (
      request: Promise<TemplateCatalogDetail | null> | undefined,
    ) => void,
  ) {}

  private previewRevision = 0;
  private detailRevision = 0;
  private cancelDetailRead = () => {};
  private cancelPreviewRead = () => {};
  onIdentityChange() {
    this.resetSelection();
    this.applying = false;
  }

  invalidateRequests() {
    this.cancelDetailRead();
    this.closePreview();
    this.detailRevision += 1;
    this.installedPluginPackages = new Set();
    this.applying = false;
    this.reviewing = false;
    this.consentWarning = null;
    this.reviewPlan = null;
    this.preparedPlan = null;
    this.riskAcknowledged = false;
  }

  dispose() {
    this.cancelDetailRead();
    this.cancelPreviewRead();
    this.disposed = true;
  }

  private source(): TemplateCatalogSource | null {
    const packageName = this.selected?.packageName;
    const version = this.detail?.version ?? this.selected?.latestVersion;
    return packageName && version ? { packageName, version } : null;
  }

  private loadDetail(reviewPlan: TemplateAddReviewPlan | null = null) {
    this.cancelDetailRead();
    const scope = this.gateway.capture();
    const packageName = this.props.initialPackageName ?? this.selected?.packageName;
    const version = this.props.initialPackageName
      ? this.props.initialVersion
      : this.selected?.latestVersion;
    if (!packageName || !scope) {
      return;
    }
    const revision = ++this.detailRevision;
    this.detail = null;
    this.installedPluginPackages = new Set();
    this.addError = null;
    const source = { packageName, ...(version ? { version } : {}) };
    this.preparedPlan = reviewPlan;
    // The detail owner resolves an unpinned release; review and Add use that exact version.
    const prepareReview = (resolvedVersion: string) => {
      if (reviewPlan) {
        return;
      }
      void readTemplateAddReviewPlan(scope.client, { packageName, version: resolvedVersion }).then(
        (plan) => {
          if (this.gateway.isCurrent(scope) && revision === this.detailRevision && !this.disposed) {
            this.preparedPlan = plan;
          }
        },
        (error: unknown) => {
          if (this.gateway.isCurrent(scope) && revision === this.detailRevision && !this.disposed) {
            this.addError = formatUiError(error);
          }
        },
      );
    };
    if (version) {
      prepareReview(version);
    }
    this.presentDetailRequest(
      new Promise((resolve, reject) => {
        // Disconnect stops a pending skeleton without clearing a settled receipt or error.
        this.cancelDetailRead = () => resolve(this.detail);
        void readTemplateDetail(scope.client, source).then(
          (detail) => {
            if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
              this.selected = detail;
              this.detail = detail;
              if (!version) {
                prepareReview(detail.version);
              }
              if (detail.contents.integrations.some((item) => item.kind === "plugin")) {
                void this.loadInstalledPlugins(revision);
              }
              resolve(detail);
            }
          },
          (error: unknown) => {
            if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
              reject(new UserFacingError(formatUiError(error), { cause: error }));
            }
          },
        );
      }),
    );
  }

  private async loadInstalledPlugins(revision: number) {
    const scope = this.gateway.capture();
    if (!scope) {
      return;
    }
    try {
      const result = await loadPluginCatalog(scope.client);
      if (!this.gateway.isCurrent(scope) || revision !== this.detailRevision) {
        return;
      }
      this.installedPluginPackages = new Set(
        result.plugins.flatMap((plugin) =>
          plugin.installed && plugin.clawhubPackage && plugin.version
            ? [`${plugin.clawhubPackage}@${plugin.version}`]
            : [],
        ),
      );
    } catch {
      // Contents remain available when the local plugin inventory cannot load.
    }
  }

  private resetSelection(selected: TemplateCatalogEntry | null = null) {
    this.detailRevision += 1;
    this.reviewing = false;
    this.applying = false;
    this.cancelDetailRead();
    this.closePreview();
    this.selected = selected;
    this.detail = null;
    this.presentDetailRequest(undefined);
    this.installedPluginPackages = new Set();
    this.addError = null;
    this.consentWarning = null;
    this.reviewPlan = null;
    this.preparedPlan = null;
    this.riskAcknowledged = false;
  }

  refresh() {
    this.loadDetail();
  }

  async addEntry(entry: TemplateCatalogEntry) {
    if (this.applying || !entry.latestVersion || !this.canAdd()) {
      return;
    }
    this.resetSelection(entry);
    await this.add(null, false, true);
  }

  openDetails(entry: TemplateCatalogEntry) {
    this.resetSelection();
    this.context.navigate("templates", {
      pathname: pathForTemplateCatalogEntry(entry.packageName, this.context.basePath),
      search: entry.latestVersion
        ? `?${new URLSearchParams({ version: entry.latestVersion })}`
        : "",
    });
  }

  private showReview() {
    if (!this.props.initialPackageName && !this.reviewing) {
      this.applying = false;
      this.reviewing = true;
      this.loadDetail(this.reviewPlan);
    }
  }

  private close() {
    this.props.onClose?.();
  }

  private back() {
    if (this.applying) {
      return;
    }
    if (this.props.initialPackageName) {
      this.close();
    } else {
      this.resetSelection();
    }
  }

  private async add(
    reviewPlan: TemplateAddReviewPlan | null = null,
    reviewsAcknowledged = false,
    prepare = false,
  ) {
    const source = this.source();
    const scope = this.gateway.capture();
    if (!source || !scope || !this.canAdd() || this.applying) {
      return;
    }
    const revision = this.detailRevision;
    const isCurrent = () =>
      !this.disposed && this.gateway.isCurrent(scope) && revision === this.detailRevision;
    this.applying = true;
    this.addError = null;
    try {
      // Prepared Gateway review still owns risk and installation consent.
      const plan = prepare
        ? await readTemplateAddReviewPlan(scope.client, source)
        : (reviewPlan ?? this.preparedPlan);
      if (!plan) {
        return;
      }
      if (!isCurrent() || !this.canAdd()) {
        return;
      }
      this.preparedPlan = plan;
      this.reviewPlan = plan;
      if (plan.riskAcknowledgementRequired && !this.riskAcknowledged) {
        this.consentWarning = plan.trustWarning ?? t("templatesCatalog.addFailed");
        this.showReview();
        return;
      }
      if (
        !reviewsAcknowledged &&
        (plan.pluginReviews.some((item) => item.ownerAction === "install") ||
          plan.skillReviews.length > 0)
      ) {
        this.showReview();
        return;
      }
      // Navigation disposes this page. The application handoff, not the dialog,
      // retains the request and releases pending chat at the agent-ready receipt.
      void addTemplateAgent(this.context, source, plan, this.riskAcknowledged).catch(
        (error: unknown) => {
          showToast({ severity: "error", message: formatUiError(error), durationMs: 12_000 });
        },
      );
    } catch (error) {
      if (isCurrent()) {
        this.addError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.applying = false;
      }
    }
  }

  private canAdd() {
    return (
      !this.disposed &&
      !this.context.agents.state.pendingAgent &&
      canCallGatewayMethod(this.gateway.snapshot, "templates.add.apply", "operator.admin")
    );
  }

  closePreview() {
    this.cancelPreviewRead();
    this.previewRevision += 1;
    this.preview = null;
  }

  async openPreview(kind: "instruction" | "skill", name: string) {
    this.cancelPreviewRead();
    const source = this.source();
    const scope = this.gateway.capture();
    const revision = ++this.previewRevision;
    const receipt = Promise.withResolvers<void>();
    this.cancelPreviewRead = receipt.resolve;
    void receipt.promise.catch(() => {});
    this.preview = { kind, name, content: null, request: receipt.promise };
    if (!source || !scope) {
      receipt.reject(new UserFacingError(t("templatesCatalog.unavailable")));
      return;
    }
    try {
      const result = await readTemplatePreview(scope.client, source, { kind, name });
      if (this.gateway.isCurrent(scope) && revision === this.previewRevision && this.preview) {
        this.preview = { ...this.preview, content: result.content };
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.previewRevision && this.preview) {
        receipt.reject(new UserFacingError(formatUiError(error), { cause: error }));
      }
    } finally {
      receipt.resolve();
    }
  }

  view(): Omit<TemplatesCatalogViewProps, "readDetail" | "detailRequest"> {
    return {
      basePath: this.context.basePath,
      selected: this.selected,
      detail: this.detail,
      preview: this.preview,
      onClosePreview: () => this.closePreview(),
      installedPluginPackages: this.installedPluginPackages,
      addError: this.addError,
      applying: this.applying,
      reviewing: this.reviewing,
      canStartAdd: this.canAdd(),
      consentWarning: this.consentWarning,
      reviewPlan: this.reviewPlan,
      canAdd: this.preparedPlan !== null && this.canAdd(),
      onOpenPreview: (kind, name) => void this.openPreview(kind, name),
      onBack: () => this.back(),
      onRetryDetail: () => this.loadDetail(),
      onConfirm: () => {
        this.riskAcknowledged = false;
        return this.add();
      },
      onConfirmConsent: () => {
        this.riskAcknowledged = true;
        this.consentWarning = null;
        return this.add(this.reviewPlan);
      },
      onCancelConsent: () => {
        this.consentWarning = null;
        this.reviewPlan = null;
        this.riskAcknowledged = false;
      },
      onConfirmReview: () => this.add(this.reviewPlan, true),
      onCancelReview: () => {
        this.reviewPlan = null;
        this.riskAcknowledged = false;
      },
    };
  }
}

export function TemplatesCatalogDialog(props: TemplatesDialogProps) {
  const context = useApplication();
  const [detailRequest, setDetailRequest] = createSignal<Promise<TemplateCatalogDetail | null>>();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [applying, showApplying] = createOptimistic(false);
  const presentMutation = action(function* (completed: Promise<void>) {
    showApplying(true);
    yield completed;
  });
  const model = new Proxy(
    new TemplatesCatalogModel(context, props, (request) => {
      void setDetailRequest(request);
    }),
    {
      set(target, key, value) {
        if (Object.is(Reflect.get(target, key), value)) {
          return true;
        }
        Reflect.set(target, key, value);
        setRevision((current) => current + 1);
        return true;
      },
    },
  );
  model.gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => model.onIdentityChange(),
    invalidateRequests: () => {
      model.invalidateRequests();
    },
    ensureInitialData: () => model.refresh(),
  });
  onSettled(() => () => {
    model.dispose();
  });
  const detail = createMemo(() => detailRequest() ?? null);
  const view = createMemo(() => {
    revision();
    return model.view();
  });
  function mutate(run: () => void | Promise<void>) {
    const alreadyApplying = model.applying;
    const scope = model.gateway.capture();
    const completed = run();
    if (alreadyApplying || !model.applying || !scope || !completed) {
      return;
    }
    // Commit owner receipts, including cleared consent, before the action holds.
    onSettled(() => {
      if (model.gateway.isCurrent(scope) && model.applying) {
        void presentMutation(completed);
      }
    });
  }
  const preview = createMemo(() => {
    revision();
    return model.preview;
  });
  const readInventory = createMemo(() => (preview()?.kind === "skill" ? preview()?.request : null));
  const readFile = createMemo(() => preview()?.request ?? null);
  const previewPath = () => (preview()?.kind === "skill" ? "SKILL.md" : (preview()?.name ?? ""));
  const files = () => {
    const current = preview();
    if (!current) {
      return [];
    }
    if (current.kind === "instruction") {
      return (model.detail?.contents.instructions ?? []).map((file) => ({
        path: file.name,
        size: "",
        contents: file.name === current.name ? (current.content ?? "") : "",
      }));
    }
    return current.content === null
      ? []
      : [{ path: previewPath(), size: "", contents: current.content }];
  };
  const content = (
    <TemplatesCatalogView
      {...view()}
      modal={props.modal}
      readPreview={readFile}
      readDetail={detail}
      detailRequest={detailRequest()}
      applying={applying() && view().applying}
      onConfirm={() => mutate(view().onConfirm)}
      onConfirmConsent={() => mutate(view().onConfirmConsent)}
      onConfirmReview={() => mutate(view().onConfirmReview)}
    />
  );
  return (
    <openclaw-templates-catalog-dialog>
      <Show
        when={props.initialPackageName || view().reviewing}
        fallback={
          <TemplatesExplore
            onSelect={(entry) => model.openDetails(entry)}
            onAdd={(entry) => void model.addEntry(entry)}
            addingPackageName={view().applying ? (view().selected?.packageName ?? null) : null}
            addDisabled={!view().canStartAdd || view().applying}
            feedback={
              <Show when={view().addError}>
                <InlineAlert tone="danger" role="alert">
                  {view().addError}
                </InlineAlert>
              </Show>
            }
          />
        }
      >
        <Show when={props.modal} fallback={content}>
          <ModalDialog
            label={t("templatesCatalog.review")}
            open
            style={{ "--openclaw-modal-width": "960px" }}
            onModal-cancel={(event: Event) => {
              if (model.applying) {
                event.preventDefault();
              } else {
                props.onClose?.();
              }
            }}
          >
            {content}
          </ModalDialog>
        </Show>
      </Show>
      <Show when={!props.modal && preview()}>
        {(current) => (
          <FilePreviewModal
            label={
              current().kind === "instruction"
                ? t("templatesCatalog.workspaceFiles")
                : current().name
            }
            files={files()}
            activePath={previewPath()}
            layout="document"
            readInventory={readInventory}
            inventoryRequest={() => (current().kind === "skill" ? current().request : undefined)}
            readFile={readFile}
            fileRequest={() => current().request}
            onFile-preview-select={(event: CustomEvent<string>) => {
              if (current().kind === "instruction" && event.detail !== current().name) {
                void model.openPreview("instruction", event.detail);
              }
            }}
            onFile-preview-retry={() => void model.openPreview(current().kind, current().name)}
            onFile-preview-close={() => model.closePreview()}
          />
        )}
      </Show>
    </openclaw-templates-catalog-dialog>
  );
}
