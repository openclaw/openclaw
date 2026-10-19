import {
  readClawHubRiskAcknowledgementRequiredError,
  readClawReviewRequiredError,
} from "@openclaw/gateway-protocol";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import "../../components/file-preview-modal-registration.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { loadPluginCatalog } from "../../lib/plugins/index.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage, type GatewayPageChange } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { preparePaneSessionHandoff } from "../chat/chat-pane-shared.ts";
import {
  applyOfficialClawAdd,
  readOfficialClawAddReviewPlan,
  readOfficialClawDetail,
  readOfficialClawPreview,
  searchOfficialClaws,
  type ClawCatalogDetail,
  type ClawCatalogEntry,
  type ClawCatalogSource,
  type ClawAddReviewPlan,
} from "./claws-catalog-client.ts";
import type { ClawsCatalogViewProps } from "./claws-catalog-view-props.ts";
import { ClawsCatalogView } from "./claws-catalog-view.tsx";

registerEnglishCatalog(registerAgentsHomeEnglish);

type ClawsDialogProps = {
  onClose?: () => void;
  onAdded?: () => void;
  onSelectEntry?: (entry: ClawCatalogEntry) => void;
  initialPackageName?: string;
  pageMode?: boolean;
};

class ClawsCatalogModel {
  entries: ClawCatalogEntry[] = [];
  query = "";
  loading = false;
  error: string | null = null;
  selected: ClawCatalogEntry | null = null;
  detail: ClawCatalogDetail | null = null;
  detailLoading = false;
  detailError: string | null = null;
  preview: {
    kind: "instruction" | "skill";
    name: string;
    content: string | null;
    loading: boolean;
    error: string | null;
  } | null = null;
  installedPluginPackages: ReadonlySet<string> = new Set();
  addError: string | null = null;
  applying = false;
  consentWarning: string | null = null;
  reviewPlan: ClawAddReviewPlan | null = null;
  private riskAcknowledged = false;
  addedAgentId: string | null = null;
  gateway!: ReturnType<typeof useGatewayPage>;
  disposed = false;

  constructor(
    readonly context: ApplicationContext,
    readonly props: ClawsDialogProps,
  ) {}

  private searchRevision = 0;
  private previewRevision = 0;
  private detailRevision = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  onIdentityChange() {
    this.entries = [];
    this.closePreview();
    this.selected = null;
    this.detail = null;
    this.detailLoading = false;
    this.detailError = null;
    this.applying = false;
    this.addError = null;
    this.installedPluginPackages = new Set();
    this.consentWarning = null;
    this.reviewPlan = null;
    this.riskAcknowledged = false;
    this.addedAgentId = null;
  }

  invalidateRequests(change: GatewayPageChange) {
    this.searchRevision += 1;
    this.closePreview();
    this.detailRevision += 1;
    this.entries = [];
    this.error = change.snapshot.phase === "connected" ? null : t("clawsCatalog.unavailable");
    this.loading = false;
    this.detailLoading = false;
    this.installedPluginPackages = new Set();
    this.applying = false;
    this.consentWarning = null;
    this.reviewPlan = null;
    this.riskAcknowledged = false;
  }

  ensureInitialData() {
    void this.loadCatalog();
  }

  dispose() {
    this.disposed = true;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private async loadCatalog() {
    const scope = this.gateway.capture();
    if (!scope) {
      return;
    }
    const revision = ++this.searchRevision;
    this.entries = [];
    this.loading = true;
    this.error = null;
    try {
      const entries = await searchOfficialClaws(
        scope.client,
        this.props.initialPackageName || this.query,
        this.props.initialPackageName ? 100 : undefined,
      );
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.entries = entries;
        if (
          this.props.initialPackageName &&
          !entries.some((entry) => entry.packageName === this.props.initialPackageName)
        ) {
          this.error = t("clawsCatalog.empty");
          return;
        }
        if (this.props.initialPackageName) {
          const entry = entries.find(
            (candidate) => candidate.packageName === this.props.initialPackageName,
          );
          if (entry) {
            this.select(entry);
          }
        }
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.error = formatUiError(error, t("clawsCatalog.unavailable"));
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.loading = false;
      }
    }
  }

  private search(query: string) {
    this.query = query;
    this.searchRevision += 1;
    this.entries = [];
    this.error = null;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.loadCatalog();
    }, 150);
  }

  private source(): ClawCatalogSource | null {
    const packageName = this.selected?.packageName;
    const version = this.detail?.version ?? this.selected?.latestVersion;
    return packageName && version ? { packageName, version } : null;
  }

  private async loadDetail() {
    const selected = this.selected;
    const scope = this.gateway.capture();
    if (!selected || !selected.latestVersion || !scope) {
      this.detailError = t("clawsCatalog.noVersion");
      return;
    }
    const revision = ++this.detailRevision;
    this.detail = null;
    this.installedPluginPackages = new Set();
    this.detailError = null;
    this.addError = null;
    this.detailLoading = true;
    try {
      const detail = await readOfficialClawDetail(scope.client, {
        packageName: selected.packageName,
        version: selected.latestVersion,
      });
      if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
        this.detail = detail;
        if (detail.contents.integrations.some((item) => item.kind === "plugin")) {
          void this.loadInstalledPlugins(revision);
        }
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
        this.detailError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.detailRevision) {
        this.detailLoading = false;
      }
    }
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

  private select(entry: ClawCatalogEntry) {
    if (!this.props.pageMode && this.props.onSelectEntry) {
      this.props.onSelectEntry(entry);
      return;
    }
    this.selected = entry;
    this.closePreview();
    this.detail = null;
    this.detailLoading = true;
    this.detailError = null;
    this.installedPluginPackages = new Set();
    this.addError = null;
    this.consentWarning = null;
    this.reviewPlan = null;
    this.riskAcknowledged = false;
    this.addedAgentId = null;
    void this.loadDetail();
  }

  private close() {
    this.props.onClose?.();
  }

  private back() {
    if (this.applying) {
      return;
    }
    if (this.props.pageMode) {
      this.close();
      return;
    }
    this.detailRevision += 1;
    this.closePreview();
    this.selected = null;
    this.detail = null;
    this.detailLoading = false;
    this.detailError = null;
    this.installedPluginPackages = new Set();
    this.addError = null;
    this.consentWarning = null;
    this.reviewPlan = null;
    this.riskAcknowledged = false;
    this.addedAgentId = null;
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
        this.addError = t("clawsCatalog.openChatFailed");
      }
    } finally {
      if (isCurrent()) {
        this.applying = false;
      }
    }
  }

  private async add(reviewPlan: ClawAddReviewPlan | null = null) {
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
        result = await applyOfficialClawAdd(scope.client, source, {
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
        if (reviewPlan || !readClawReviewRequiredError(error)) {
          throw error;
        }
        const plan = await readOfficialClawAddReviewPlan(scope.client, source);
        if (
          !plan.pluginReviews.some((item) => item.ownerAction === "install") &&
          plan.skillReviews.length === 0
        ) {
          throw new Error(t("clawsCatalog.addFailed"), { cause: error });
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
        throw new Error(result.error?.message ?? t("clawsCatalog.addFailed"));
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
    return canCallGatewayMethod(this.gateway.snapshot, "claws.add.apply", "operator.admin");
  }

  closePreview() {
    this.previewRevision += 1;
    this.preview = null;
  }

  async openPreview(kind: "instruction" | "skill", name: string) {
    const source = this.source();
    const scope = this.gateway.capture();
    const revision = ++this.previewRevision;
    this.preview = {
      kind,
      name,
      content: null,
      loading: Boolean(source && scope),
      error: source && scope ? null : t("clawsCatalog.unavailable"),
    };
    if (!source || !scope) {
      return;
    }
    try {
      const result = await readOfficialClawPreview(scope.client, source, { kind, name });
      if (this.gateway.isCurrent(scope) && revision === this.previewRevision && this.preview) {
        this.preview = { ...this.preview, content: result.content, loading: false };
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.previewRevision && this.preview) {
        this.preview = { ...this.preview, loading: false, error: formatUiError(error) };
      }
    }
  }

  view(): ClawsCatalogViewProps {
    return {
      entries: this.entries,
      basePath: this.context.basePath,
      query: this.query,
      loading: this.loading,
      error: this.error,
      selected: this.selected,
      pageMode: this.props.pageMode ?? false,
      detail: this.detail,
      detailLoading: this.detailLoading,
      detailError: this.detailError,
      installedPluginPackages: this.installedPluginPackages,
      addError: this.addError,
      applying: this.applying,
      consentWarning: this.consentWarning,
      reviewPlan: this.reviewPlan,
      addedAgentId: this.addedAgentId,
      canAdd: this.canAdd(),
      onOpenPreview: (kind, name) => void this.openPreview(kind, name),
      onSearch: (query) => this.search(query),
      onSelect: (entry) => this.select(entry),
      onBack: () => this.back(),
      onClose: () => this.close(),
      onRetryCatalog: () => void this.loadCatalog(),
      onRetryDetail: () => void this.loadDetail(),
      onConfirm: () => {
        this.riskAcknowledged = false;
        void this.add();
      },
      onConfirmConsent: () => {
        this.riskAcknowledged = true;
        this.consentWarning = null;
        void this.add(this.reviewPlan);
      },
      onCancelConsent: () => {
        this.consentWarning = null;
        this.reviewPlan = null;
        this.riskAcknowledged = false;
      },
      onConfirmReview: () => void this.add(this.reviewPlan),
      onCancelReview: () => {
        this.reviewPlan = null;
        this.riskAcknowledged = false;
      },
      onRetryOpenChat: () => {
        if (this.addedAgentId) {
          void this.finishChatHandoff(this.addedAgentId, this.context);
        }
      },
    };
  }
}

export function ClawsCatalogDialog(props: ClawsDialogProps) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const model = new Proxy(new ClawsCatalogModel(context, props), {
    set(target, key, value) {
      if (Object.is(Reflect.get(target, key), value)) {
        return true;
      }
      Reflect.set(target, key, value);
      setRevision((current) => current + 1);
      return true;
    },
  });
  model.gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => model.onIdentityChange(),
    invalidateRequests: (change) => model.invalidateRequests(change),
    ensureInitialData: () => model.ensureInitialData(),
  });
  onCleanup(() => model.dispose());
  const view = createMemo(() => {
    revision();
    return model.view();
  });
  const preview = createMemo(() => {
    revision();
    return model.preview;
  });
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
    <openclaw-claws-catalog-dialog>
      <ClawsCatalogView {...view()} />
      <Show when={preview()}>
        {(current) => (
          <openclaw-file-preview-modal
            prop:label={
              current().kind === "instruction" ? t("clawsCatalog.workspaceFiles") : current().name
            }
            prop:files={files()}
            prop:activePath={previewPath()}
            layout="document"
            prop:loading={current().kind === "skill" && current().loading}
            prop:fileLoading={current().kind === "instruction" && current().loading}
            prop:error={current().error ?? ""}
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
    </openclaw-claws-catalog-dialog>
  );
}
