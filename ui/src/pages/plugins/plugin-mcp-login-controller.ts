import { WizardLoginController } from "../../components/wizard-login-controller.ts";
import { t } from "../../i18n/index.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type { ModelSetupWizardCompletion } from "../model-setup/wizard-runner.ts";
import type { PluginsPageDetail } from "./plugins-page-model.ts";

/** Binds the shared OAuth dialog to the selected plugin and live Gateway. */
export class PluginMcpLoginController {
  private selection: { pluginId: string; scope: GatewayConnectionScope } | null = null;
  private readonly dialog: WizardLoginController;

  constructor(
    host: { requestUpdate: () => void },
    private readonly gateway: GatewayPageBinding,
    private readonly options: {
      getDetail: () => PluginsPageDetail | null;
      getName: (pluginId: string) => string | undefined;
      canSignIn: () => boolean;
      refresh: (pluginId: string) => Promise<void>;
    },
  ) {
    this.dialog = new WizardLoginController(host, {
      getClient: () => gateway.client,
      getAgentId: () => null,
      requestFailedMessage: () => t("pluginsPage.auth.requestFailed"),
      sessionExpiredMessage: () => t("pluginsPage.auth.sessionExpired"),
      onClose: () => {
        const pluginId = this.selection?.pluginId;
        this.reset();
        if (pluginId && options.getDetail()?.pluginId === pluginId) {
          void options.refresh(pluginId);
        }
      },
      onAnswer: (value, includeValue) => {
        const selection = this.selection;
        void this.dialog.runner.answer(value, includeValue).then((completion) => {
          if (selection === this.selection) {
            void this.complete(completion);
          }
        });
      },
      onBackgroundCompletion: (completion) => this.complete(completion),
    });
  }

  get busy() {
    return this.dialog.runner.state.phase !== "idle";
  }

  select(pluginId: string | null) {
    if (this.selection && this.selection.pluginId !== pluginId) {
      this.reset();
    }
  }

  reset() {
    this.selection = null;
    this.dialog.reset();
  }

  render() {
    return this.dialog.render();
  }

  async start(serverName: string): Promise<void> {
    const scope = this.gateway.capture();
    const detail = this.options.getDetail();
    if (
      !scope ||
      !detail ||
      !this.options.canSignIn() ||
      this.busy ||
      !detail.inspection?.mcpAuth?.some(
        (entry) => entry.serverName === serverName && entry.state !== "authorized",
      )
    ) {
      return;
    }
    const selection = { pluginId: detail.pluginId, scope };
    this.selection = selection;
    this.dialog.runner.prepareSignIn("oauth", this.options.getName(detail.pluginId) ?? serverName);
    const completion = await this.dialog.runner.startMcpLogin(serverName);
    if (selection === this.selection) {
      await this.complete(completion);
    }
  }

  private async complete(completion: ModelSetupWizardCompletion | null): Promise<void> {
    const selection = this.selection;
    if (
      !completion ||
      completion.isCurrent?.() === false ||
      !selection ||
      !this.gateway.isCurrent(selection.scope) ||
      this.options.getDetail()?.pluginId !== selection.pluginId
    ) {
      return;
    }
    // Tokens are saved by the OAuth owner. Re-inspect this same plugin instead
    // of optimistically marking a connection authenticated in the renderer.
    this.reset();
    await this.options.refresh(selection.pluginId);
  }
}
