import {
  readClawHubRiskAcknowledgementRequiredError,
  readTemplateReviewRequiredError,
} from "@openclaw/gateway-protocol";
import { action, createMemo, createOptimistic, createSignal, onSettled, Show } from "solid-js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { FilePreviewModal } from "../../components/file-preview-modal.tsx";
import { registerTemplatesEnglish } from "../../i18n/locales/en-templates.ts";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import { formatUiError, UserFacingError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { loadPluginCatalog } from "../../lib/plugins/index.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { preparePaneSessionHandoff } from "../chat/chat-pane-shared.ts";
import {
  applyTemplateAdd,
  readTemplateAddReviewPlan,
  readTemplateDetail,
  readTemplatePreview,
  searchTemplates,
  type TemplateCatalogDetail,
  type TemplateCatalogEntry,
  type TemplateCatalogSource,
  type TemplateAddReviewPlan,
} from "./templates-catalog-client.ts";
import type { TemplatesCatalogViewProps } from "./templates-catalog-view-props.ts";
import { TemplatesCatalogView } from "./templates-catalog-view.tsx";

registerEnglishCatalog(registerTemplatesEnglish);

type TemplatesDialogProps = {
  onClose?: () => void;
  onAdded?: () => void;
  initialPackageName: string;
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
  consentWarning: string | null = null;
  reviewPlan: TemplateAddReviewPlan | null = null;
  private riskAcknowledged = false;
  addedAgentId: string | null = null;
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
    this.consentWarning = null;
    this.reviewPlan = null;
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

  private loadDetail() {
    this.cancelDetailRead();
    const selected = this.selected;
    const scope = this.gateway.capture();
    if (!selected || !selected.latestVersion || !scope) {
      this.presentDetailRequest(Promise.reject(new Error(t("templatesCatalog.noVersion"))));
      return;
    }
    const revision = ++this.detailRevision;
    this.detail = null;
    this.installedPluginPackages = new Set();
    this.addError = null;
    const source = { packageName: selected.packageName, version: selected.latestVersion };
    this.presentDetailRequest(
      new Promise((resolve, reject) => {
        // Disconnect stops a pending skeleton without clearing a settled receipt or error.
        this.cancelDetailRead = () => resolve(this.detail);
        void readTemplateDetail(scope.client, source).then(
          (detail) => {
            if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
              this.detail = detail;
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
        result.plugins
          .flatMap((plugin) =>
            plugin.installed ? [plugin.clawhubPackage, plugin.packageName] : [],
          )
          .filter((name): name is string => Boolean(name)),
      );
    } catch {
      // Contents remain available when the local plugin inventory cannot load.
    }
  }

  private resetSelection(selected: TemplateCatalogEntry | null = null) {
    this.cancelDetailRead();
    this.closePreview();
    this.selected = selected;
    this.detail = null;
    this.presentDetailRequest(undefined);
    this.installedPluginPackages = new Set();
    this.addError = null;
    this.consentWarning = null;
    this.reviewPlan = null;
    this.riskAcknowledged = false;
    this.addedAgentId = null;
  }

  select(entry: TemplateCatalogEntry) {
    this.resetSelection(entry);
    this.loadDetail();
  }

  private close() {
    this.props.onClose?.();
  }

  private back() {
    if (this.applying) {
      return;
    }
    this.close();
  }

  private openAgentChat(agentId: string, agentName: string, context: ApplicationContext) {
    const mainKey =
      resolveUiConfiguredMainKey({
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      }) ?? "main";
    const sessionKey = buildAgentMainSessionKey({ agentId, mainKey });
    const target = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey,
      agentId,
    });
    preparePaneSessionHandoff(
      context,
      loadSettings().chatSplitLayout?.activePaneId ?? "p1",
      sessionKey,
      {
        draft: `${agentName}, what can you do?`,
        attachments: [],
        send: true,
      },
    );
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId,
    });
    this.close();
    context.navigate("chat", target.options);
  }

  private async finishChatHandoff(agentId: string, context: ApplicationContext) {
    if (this.applying) {
      return;
    }
    const revision = this.detailRevision;
    const isCurrent = () =>
      !this.disposed &&
      revision === this.detailRevision &&
      this.context === context &&
      this.addedAgentId === agentId;
    this.applying = true;
    this.addError = null;
    try {
      const deadline = Date.now() + 15_000;
      while (isCurrent()) {
        try {
          const roster = await context.agents.refreshList();
          if (!isCurrent()) {
            return;
          }
          const agent = roster?.agents.find((entry) => entry.id === agentId);
          if (agent) {
            this.props.onAdded?.();
            this.openAgentChat(agentId, normalizeAgentLabel(agent), context);
            return;
          }
        } catch {
          if (!isCurrent()) {
            return;
          }
        }
        if (Date.now() >= deadline) {
          break;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 400);
        });
      }
      if (isCurrent()) {
        this.addError = t("templatesCatalog.openChatFailed");
      }
    } finally {
      if (isCurrent()) {
        this.applying = false;
      }
    }
  }

  private async add(reviewPlan: TemplateAddReviewPlan | null = null) {
    const source = this.source();
    const scope = this.gateway.capture();
    if (!source || !this.detail || !scope || !this.canAdd() || this.applying || this.addedAgentId) {
      return;
    }
    const revision = this.detailRevision;
    const context = this.context;
    let resultAgentId: string | null = null;
    this.applying = true;
    this.addError = null;
    try {
      let result;
      try {
        result = await applyTemplateAdd(scope.client, source, {
          acknowledgeClawHubRisk: this.riskAcknowledged,
          ...(reviewPlan ? { reviewPlan } : {}),
        });
      } catch (error) {
        const risk = readClawHubRiskAcknowledgementRequiredError(error);
        if (risk) {
          if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
            this.consentWarning = risk.warning;
          }
          return;
        }
        if (reviewPlan || !readTemplateReviewRequiredError(error)) {
          throw error;
        }
        const plan = await readTemplateAddReviewPlan(scope.client, source);
        if (
          !plan.pluginReviews.some((item) => item.ownerAction === "install") &&
          plan.skillReviews.length === 0
        ) {
          throw new Error(t("templatesCatalog.addFailed"), { cause: error });
        }
        if (
          !this.gateway.isCurrent(scope) ||
          revision !== this.detailRevision ||
          this.context !== context
        ) {
          return;
        }
        this.reviewPlan = plan;
        return;
      }
      if (
        !this.gateway.isCurrent(scope) ||
        revision !== this.detailRevision ||
        this.context !== context
      ) {
        return;
      }
      if (!result.agentId || result.status !== "complete") {
        throw new Error(result.error?.message ?? t("templatesCatalog.addFailed"));
      }
      this.consentWarning = null;
      this.reviewPlan = null;
      this.riskAcknowledged = false;
      this.addedAgentId = result.agentId;
      resultAgentId = result.agentId;
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
        this.addError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
        this.applying = false;
      }
    }
    if (resultAgentId && this.addedAgentId === resultAgentId && this.gateway.isCurrent(scope)) {
      await this.finishChatHandoff(resultAgentId, context);
    }
  }

  private canAdd() {
    return canCallGatewayMethod(this.gateway.snapshot, "templates.add.apply", "operator.admin");
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

  view(): Omit<
    TemplatesCatalogViewProps,
    "readEntries" | "catalogRequest" | "onRetryCatalog" | "readDetail" | "detailRequest"
  > {
    return {
      basePath: this.context.basePath,
      selected: this.selected,
      detail: this.detail,
      installedPluginPackages: this.installedPluginPackages,
      addError: this.addError,
      applying: this.applying,
      consentWarning: this.consentWarning,
      reviewPlan: this.reviewPlan,
      addedAgentId: this.addedAgentId,
      canAdd: this.canAdd(),
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
      onConfirmReview: () => this.add(this.reviewPlan),
      onCancelReview: () => {
        this.reviewPlan = null;
        this.riskAcknowledged = false;
      },
      onRetryOpenChat: () => {
        if (this.addedAgentId) {
          return this.finishChatHandoff(this.addedAgentId, this.context);
        }
        return undefined;
      },
    };
  }
}

export function TemplatesCatalogDialog(props: TemplatesDialogProps) {
  const context = useApplication();
  const [catalogRequest, setCatalogRequest] = createSignal<Promise<TemplateCatalogEntry[]>>();
  let cancelSearch = () => {};
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
      cancelSearch();
      setCatalogRequest(undefined);
      model.invalidateRequests();
    },
    ensureInitialData: () => loadCatalog(),
  });
  onSettled(() => () => {
    cancelSearch();
    model.dispose();
  });
  function loadCatalog() {
    cancelSearch();
    const scope = model.gateway.capture();
    if (!scope) {
      return;
    }
    const packageName = props.initialPackageName;
    let cancelled = false;
    cancelSearch = () => {
      cancelled = true;
    };
    const isCurrent = () => !cancelled && model.gateway.isCurrent(scope);
    // Admission also refreshes hidden detail pages on reconnect. Keep selection
    // at request completion, outside the async rendering computation.
    void setCatalogRequest(
      (async () => {
        if (!isCurrent()) {
          return [];
        }
        const entries = await searchTemplates(scope.client, packageName, 100);
        if (isCurrent()) {
          const entry = entries.find((candidate) => candidate.packageName === packageName);
          if (!entry) {
            throw new Error(t("templatesCatalog.empty"));
          }
          model.select(entry);
        }
        return entries;
      })(),
    );
  }
  const entries = createMemo(() => {
    const request = catalogRequest();
    if (!request && !model.gateway.connected) {
      throw new Error(t("templatesCatalog.unavailable"));
    }
    return request ?? [];
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
  return (
    <openclaw-templates-catalog-dialog>
      <TemplatesCatalogView
        {...view()}
        readEntries={entries}
        catalogRequest={catalogRequest()}
        readDetail={detail}
        detailRequest={detailRequest()}
        onRetryCatalog={() => loadCatalog()}
        applying={applying() && view().applying}
        onConfirm={() => mutate(view().onConfirm)}
        onConfirmConsent={() => mutate(view().onConfirmConsent)}
        onConfirmReview={() => mutate(view().onConfirmReview)}
        onRetryOpenChat={() => mutate(view().onRetryOpenChat)}
      />
      <Show when={preview()}>
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
