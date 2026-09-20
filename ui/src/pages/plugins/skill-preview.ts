import { html, nothing, type ReactiveControllerHost } from "lit";
import type {
  PluginsSkillsReadParams,
  PluginsSkillsReadResult,
} from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
import type { FilePreviewModalFile } from "../../components/file-preview-modal.ts";
import { icons } from "../../components/icons.ts";
import "../../components/file-preview-modal-registration.ts";
import { t } from "../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../i18n/locales/en-file-preview.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { renderPluginCapabilitySection } from "./overview.ts";
import { showPluginToolPreview, type PluginToolPreview } from "./tool-preview.ts";
import "./skill-preview.css";

registerFilePreviewEnglish();
registerPluginManagementEnglish();

export type PluginSkillPreviewState = {
  request: PluginsSkillsReadParams;
  loading: boolean;
  error: string | null;
  result: PluginsSkillsReadResult | null;
  activePath: string;
};

export class PluginPreviewController {
  state: PluginSkillPreviewState | null = null;
  private sequence = 0;
  private toolAbort = new AbortController();

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly gateway: GatewayPageController,
  ) {}

  async open(request: PluginsSkillsReadParams): Promise<void> {
    this.close();
    const sequence = this.sequence;
    const connection = this.gateway.capture();
    this.state = {
      request: { ...request },
      loading: Boolean(connection),
      error: connection ? null : t("pluginsPage.connectToManage"),
      result: null,
      activePath: "SKILL.md",
    };
    this.host.requestUpdate();
    if (!connection) {
      return;
    }
    const current = () => this.sequence === sequence && this.gateway.isCurrent(connection);
    try {
      const result = await connection.client.request<PluginsSkillsReadResult>(
        "plugins.skills.read",
        request,
      );
      if (current() && this.state) {
        this.state.result = result;
        this.state.activePath = result.entryPath;
      }
    } catch (error) {
      if (current() && this.state) {
        this.state.error = formatUiError(error);
      }
    } finally {
      if (current() && this.state) {
        this.state.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  openTool(tool: PluginToolPreview): void {
    this.close();
    void showPluginToolPreview(tool, this.toolAbort.signal);
  }

  retry(): void {
    if (this.state) {
      void this.open(this.state.request);
    }
  }
  select(path: string): void {
    if (this.state?.result?.files.some((file) => file.path === path)) {
      this.state.activePath = path;
      this.host.requestUpdate();
    }
  }
  /** Dismissal, route changes and connection changes retire outstanding reads. */
  close(): void {
    this.sequence++;
    this.toolAbort.abort();
    this.toolAbort = new AbortController();
    this.state = null;
    this.host.requestUpdate();
  }
}

export function renderPluginSkillPreview(controller: PluginPreviewController) {
  const state = controller.state;
  if (!state) {
    return nothing;
  }
  const files: FilePreviewModalFile[] =
    state.result?.files.map((file) => ({
      path: file.path,
      size: `${file.sizeBytes.toLocaleString()} B`,
      contents: file.content ?? "",
      ...(file.status !== "ready" ? { message: t(`filePreview.bundle.${file.status}`) } : {}),
    })) ?? [];
  const incomplete =
    state.result &&
    (!state.result.inventoryComplete ||
      state.result.files.some(
        (file) => file.status === "unavailable" || file.status === "too-large",
      ));
  return html`<openclaw-file-preview-modal
    .label=${state.request.skillName}
    .listLabel=${t("pluginsPage.detailTabs.skills")}
    .files=${files}
    .directories=${state.result?.directories ?? []}
    .activePath=${state.activePath}
    .showSearch=${false}
    .showCopy=${false}
    .folderTree=${true}
    .renderMarkdown=${true}
    .loading=${state.loading}
    .error=${state.error ?? ""}
    .notice=${incomplete ? t("filePreview.bundle.incomplete") : ""}
    .emptyTitle=${state.loading ? t("common.loading") : t("filePreview.emptyTitle")}
    .emptySubtitle=${state.loading ? "" : t("filePreview.emptySubtitle")}
    @file-preview-select=${(event: CustomEvent<string>) => controller.select(event.detail)}
    @file-preview-retry=${() => controller.retry()}
    @file-preview-close=${() => controller.close()}
  ></openclaw-file-preview-modal>`;
}

export function renderPluginSkillsSection(
  skills: ReadonlyArray<{ name: string; description?: string }>,
  onOpen: (name: string) => void,
) {
  return html`<div class="plugin-skills-section">
    ${renderPluginCapabilitySection(t("pluginsPage.detailTabs.skills"), [...skills], icons.book, onOpen)}
  </div>`;
}
