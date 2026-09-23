import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { pathForPluginSettings } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { DecisionModelEntry } from "../../components/decision-model-picker.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { modelProviderConfigBusy } from "./config-mutation.ts";
import { renderProviderConnectionDialog } from "./connection-dialog.ts";
registerSettingsEnglish();

type Options = {
  getScope: () => { context: ApplicationContext; agentId: string | null };
  getModels: () => readonly DecisionModelEntry[];
  getSelection: () => string | null | undefined;
};
type Intent = {
  model: DecisionModelEntry;
  current: () => boolean;
  commit?: () => void;
  phase: "setup" | "saved" | "confirm";
};

/** Retains selection intent only; config and protected credential persistence stay with their owners. */
export class DecisionModelSetupController implements ReactiveController {
  private intent: Intent | null = null;
  private generation = 0;
  private key = "";
  private error = "";
  private saving = false;
  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: Options,
  ) {
    host.addController(this);
  }
  get busy() {
    return this.intent !== null;
  }
  choose(value: string | null, commit: (value: string | null) => void) {
    const model = this.options
      .getModels()
      .find((entry) => `${entry.provider}/${entry.id}` === value);
    if (value && !model) {
      this.reset();
      this.error = t("modelProviders.decisionSetup.selectionStale");
      this.host.requestUpdate();
      return;
    }
    if (!model?.setup || model.readiness === "configured") {
      this.reset();
      commit(value);
      return;
    }
    this.open(model, () => commit(value));
  }
  open(model: DecisionModelEntry, commit?: () => void) {
    this.reset();
    const scope = this.options.getScope();
    const { client, hello } = scope.context.gateway.snapshot;
    if (!client) {
      return;
    }
    const generation = this.generation;
    const previous = this.options.getSelection();
    const current = () => {
      const now = this.options.getScope();
      return (
        generation === this.generation &&
        now.context === scope.context &&
        now.context.gateway.snapshot.client === client &&
        now.context.gateway.snapshot.hello === hello &&
        now.agentId === scope.agentId &&
        (!commit || this.options.getSelection() === previous)
      );
    };
    this.intent = { model, current, commit, phase: "setup" };
    this.host.requestUpdate();
  }
  reset() {
    this.generation++;
    this.intent = null;
    this.key = "";
    this.error = "";
    this.saving = false;
    this.host.requestUpdate();
  }
  hostDisconnected() {
    this.reset();
  }
  private async refresh(intent: Intent) {
    const { context, agentId } = this.options.getScope();
    const client = context.gateway.snapshot.client;
    if (!client || !agentId || !intent.current()) {
      return;
    }
    const catalog = await loadModelCatalog(client, { agentId, view: "configured", refresh: true });
    if (!intent.current()) {
      return;
    }
    const model = catalog.decisionModels?.find(
      (entry) => entry.provider === intent.model.provider && entry.id === intent.model.id,
    );
    if (!model) {
      this.error = t("modelProviders.decisionSetup.stale");
      return;
    }
    intent.model = model;
    if (model.readiness === "configured") {
      intent.phase = "confirm";
      this.error = "";
    }
    this.host.requestUpdate();
  }
  private async save(intent: Intent) {
    const { context } = this.options.getScope();
    const gateway = context.gateway.snapshot;
    const path = intent.model.setup?.credentialPath;
    if (
      this.saving ||
      !intent.current() ||
      !gateway.client ||
      !path ||
      !this.key.trim() ||
      !canCallGatewayMethod(gateway, "plugins.credentials.set", "operator.admin", {
        requireAdvertisement: false,
      })
    ) {
      return;
    }
    this.saving = true;
    this.error = "";
    this.host.requestUpdate();
    try {
      const result = await context.runtimeConfig.runExternalMutation(
        (client) => {
          const baseHash = context.runtimeConfig.state.configSnapshot?.hash;
          if (!baseHash) {
            throw new Error(t("modelProviders.decisionSetup.stale"));
          }
          return client.request<{ saved: true; warning?: string }>("plugins.credentials.set", {
            pluginId: intent.model.pluginId,
            path,
            baseHash,
            value: this.key,
          });
        },
        {
          canDispatch: () => intent.current() && clientIsCurrent(),
          dispatchError: t("modelProviders.decisionSetup.stale"),
        },
      );
      if (!intent.current()) {
        return;
      }
      if (!result.ok) {
        this.error = result.error;
        return;
      }
      this.key = "";
      intent.phase = "saved";
      if (result.value.warning || !result.refresh.ok) {
        this.error = result.value.warning || (!result.refresh.ok ? result.refresh.error : "");
        return;
      }
      await this.refresh(intent);
      if (!intent.current()) {
        return;
      }
      if (intent.commit) {
        if (intent.model.readiness !== "configured") {
          this.error = t("modelProviders.decisionSetup.notReady");
          return;
        }
        intent.phase = "confirm";
      } else {
        this.reset();
      }
    } catch (error) {
      if (intent.current()) {
        this.error = formatUiError(error, t("modelProviders.decisionSetup.failed"));
      }
    } finally {
      if (this.intent === intent) {
        if (!intent.current()) {
          this.reset();
        } else {
          this.saving = false;
          this.host.requestUpdate();
        }
      }
    }
    function clientIsCurrent() {
      return (
        context.gateway.snapshot.client === gateway.client &&
        canCallGatewayMethod(
          context.gateway.snapshot,
          "plugins.credentials.set",
          "operator.admin",
          { requireAdvertisement: false },
        )
      );
    }
  }
  render() {
    const intent = this.intent;
    if (!intent) {
      return this.error
        ? html`<div class="callout error" role="alert">${this.error}</div>`
        : nothing;
    }
    const setup = intent.model.setup;
    if (!setup) {
      return nothing;
    }
    const current = intent.current();
    const admin = canCallGatewayMethod(
      this.options.getScope().context.gateway.snapshot,
      "plugins.credentials.set",
      "operator.admin",
      { requireAdvertisement: false },
    );
    const keyForm =
      setup.kind === "api-key" && Boolean(setup.credentialPath) && intent.phase === "setup";
    const use =
      Boolean(intent.commit) &&
      intent.phase === "confirm" &&
      intent.model.readiness === "configured";
    return renderProviderConnectionDialog({
      title:
        intent.phase !== "setup"
          ? t(
              setup.kind === "api-key"
                ? "modelProviders.decisionSetup.saved"
                : "modelProviders.decisionSetup.ready",
            )
          : t("modelProviders.decisionSetup.title", { provider: setup.label }),
      description:
        use && intent.phase === "confirm"
          ? t("modelProviders.decisionSetup.confirm", { model: intent.model.name })
          : intent.phase === "saved"
            ? t("modelProviders.decisionSetup.notReady")
            : setup.help,
      busy: this.saving,
      disabled:
        !current ||
        modelProviderConfigBusy(this.options.getScope().context) ||
        (keyForm && (!admin || !this.key.trim())),
      ...(keyForm
        ? {
            key: {
              value: this.key,
              disabled: !current || !admin,
              onChange: (value: string) => {
                this.key = value;
                this.host.requestUpdate();
              },
            },
          }
        : {}),
      error: !current
        ? t("modelProviders.decisionSetup.stale")
        : this.error || (!admin && keyForm ? t("modelProviders.decisionSetup.admin") : undefined),
      content: html`<p class="muted">${t("modelProviders.decisionSetup.shared")}</p>
        ${intent.commit && intent.phase === "setup" ? html`<p>${t("modelProviders.decisionSetup.pending", { model: intent.model.name })}</p>` : nothing}${use ? html`<p class="muted">${t(setup.kind === "api-key" ? "modelProviders.decisionSetup.unverified" : "modelProviders.decisionSetup.local")}</p>` : nothing}${!keyForm || this.error ? html`<a href=${pathForPluginSettings(intent.model.pluginId, this.options.getScope().context.basePath)} target="_blank" rel="noopener noreferrer">${t("modelProviders.decisionSetup.manage")}</a>` : nothing}${setup.documentationUrl ? html`<p><a href=${setup.documentationUrl} target="_blank" rel="noopener noreferrer">${t("modelProviders.decisionSetup.docs")}</a></p>` : nothing}`,
      actionLabel: keyForm
        ? t("modelProviders.decisionSetup.title", { provider: setup.label })
        : use
          ? t("modelProviders.decisionSetup.use", { model: intent.model.name })
          : t("modelProviders.decisionSetup.retry"),
      onCancel: () => this.reset(),
      onAction: () => {
        if (!intent.current() || modelProviderConfigBusy(this.options.getScope().context)) {
          return;
        }
        if (keyForm) {
          void this.save(intent);
        } else if (use) {
          const commit = intent.commit;
          this.reset();
          commit?.();
        } else {
          void this.refresh(intent).catch((error: unknown) => {
            if (intent.current()) {
              this.error = formatUiError(error);
              this.host.requestUpdate();
            }
          });
        }
      },
    });
  }
}
