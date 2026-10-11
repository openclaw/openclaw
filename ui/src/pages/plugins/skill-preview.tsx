import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type {
  PluginsSkillsReadParams,
  PluginsSkillsReadResult,
} from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
import type { FilePreviewModalFile } from "../../components/file-preview-modal.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerFilePreviewEnglish } from "../../i18n/locales/en-file-preview.ts";
import "../../components/file-preview-modal-registration.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "./custom-elements.ts";
import { renderPluginCapabilitySection as PluginCapabilitySection } from "./overview.tsx";
import { showPluginToolPreview, type PluginToolPreview } from "./tool-preview.tsx";
import "./skill-preview.css";

registerEnglishCatalog(registerFilePreviewEnglish);
registerEnglishCatalog(registerPluginManagementEnglish);

export type PluginSkillPreviewState = {
  request: PluginsSkillsReadParams;
  loading: boolean;
  error: string | null;
  result: PluginsSkillsReadResult | null;
  activePath: string;
  pendingPaths: Set<string>;
  fileErrors: Map<string, string>;
};

export class PluginPreviewController {
  state: PluginSkillPreviewState | null = null;
  private toolAbort = new AbortController();

  constructor(
    private readonly host: { requestUpdate: () => void },
    private readonly gateway: GatewayPageBinding,
  ) {}

  async open(request: PluginsSkillsReadParams): Promise<void> {
    this.close();
    const connection = this.gateway.capture();
    const state: PluginSkillPreviewState = {
      request: { ...request },
      loading: Boolean(connection),
      error: connection ? null : t("pluginsPage.connectToManage"),
      result: null,
      activePath: "SKILL.md",
      pendingPaths: new Set(),
      fileErrors: new Map(),
    };
    this.state = state;
    this.host.requestUpdate();
    if (!connection) {
      return;
    }
    const current = () => this.state === state && this.gateway.isCurrent(connection);
    try {
      const result = await connection.client.request<PluginsSkillsReadResult>(
        "plugins.skills.read",
        request,
      );
      if (current()) {
        state.result = result;
        state.activePath = result.entryPath;
        if (result.version) {
          state.request = { ...state.request, version: result.version };
        }
      }
    } catch (error) {
      if (current()) {
        state.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        state.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  openTool(tool: PluginToolPreview): void {
    this.close();
    void showPluginToolPreview(tool, this.toolAbort.signal);
  }

  retry(): void {
    if (this.state?.result) {
      void this.select(this.state.activePath);
    } else if (this.state) {
      void this.open(this.state.request);
    }
  }
  async select(path: string): Promise<void> {
    const state = this.state;
    const file = state?.result?.files.find((candidate) => candidate.path === path);
    if (!state || !file) {
      return;
    }
    state.activePath = path;
    this.host.requestUpdate();
    if (
      state.pendingPaths.has(path) ||
      (file.status !== "deferred" && file.status !== "unavailable")
    ) {
      return;
    }
    const connection = this.gateway.capture();
    if (!connection) {
      state.fileErrors.set(path, t("pluginsPage.connectToManage"));
      return;
    }
    const current = () => this.state === state && this.gateway.isCurrent(connection);
    state.pendingPaths.add(path);
    state.fileErrors.delete(path);
    try {
      const result = await connection.client.request<PluginsSkillsReadResult>(
        "plugins.skills.read",
        { ...state.request, path },
      );
      if (!current() || !state.result) {
        return;
      }
      const selected = result.files.find((candidate) => candidate.path === path);
      if (
        result.version !== state.result.version ||
        result.rootPath !== state.result.rootPath ||
        !selected ||
        selected.status === "deferred"
      ) {
        throw new Error(t("filePreview.bundle.unavailable"));
      }
      // Merge only this requested body. Late sibling responses never replace the
      // foreground selection or discard already loaded bodies in this preview.
      state.result = {
        ...state.result,
        files: state.result.files.map((candidate) =>
          candidate.path === path ? selected : candidate,
        ),
      };
    } catch (error) {
      if (current()) {
        state.fileErrors.set(path, formatUiError(error));
      }
    } finally {
      if (current()) {
        state.pendingPaths.delete(path);
        this.host.requestUpdate();
      }
    }
  }
  /** Dismissal, route changes and connection changes retire outstanding reads. */
  close(): void {
    this.toolAbort.abort();
    this.toolAbort = new AbortController();
    this.state = null;
    this.host.requestUpdate();
  }
}

export function PluginSkillPreview(props: {
  controller: PluginPreviewController;
  state: PluginSkillPreviewState | null;
}) {
  const files = createMemo<FilePreviewModalFile[]>(
    () =>
      props.state?.result?.files.map((file) => ({
        path: file.path,
        size: "",
        contents: file.content ?? "",
        ...(file.status !== "ready" && file.status !== "deferred"
          ? { message: t(`filePreview.bundle.${file.status}`) }
          : {}),
      })) ?? [],
  );
  const activeFile = createMemo(() =>
    props.state?.result?.files.find((file) => file.path === props.state?.activePath),
  );
  const fileError = createMemo(
    () =>
      props.state?.fileErrors.get(props.state.activePath) ??
      (activeFile()?.status === "unavailable" ? t("filePreview.bundle.unavailable") : ""),
  );
  const incomplete = createMemo(
    () =>
      props.state?.result &&
      (!props.state.result.inventoryComplete ||
        props.state.result.files.some(
          (file) => file.status === "unavailable" || file.status === "too-large",
        )),
  );
  return (
    <>
      {props.state && (
        <openclaw-file-preview-modal
          prop:label={props.state.request.skillName}
          prop:files={files()}
          prop:directories={props.state.result?.directories ?? []}
          prop:activePath={props.state.activePath}
          layout="document"
          prop:loading={props.state.loading}
          prop:fileLoading={props.state.pendingPaths.has(props.state.activePath)}
          prop:error={
            props.state.error ??
            (props.state.pendingPaths.has(props.state.activePath) ? "" : fileError())
          }
          prop:notice={incomplete() ? t("filePreview.bundle.incomplete") : ""}
          onFile-preview-select={(event: CustomEvent<string>) =>
            void props.controller.select(event.detail)
          }
          onFile-preview-retry={() => props.controller.retry()}
          onFile-preview-close={() => props.controller.close()}
        />
      )}
    </>
  );
}

export function renderPluginSkillPreview(controller: PluginPreviewController): JSX.Element {
  return <PluginSkillPreview controller={controller} state={controller.state} />;
}

export function renderPluginSkillsSection(
  skills: ReadonlyArray<{ name: string; description?: string }>,
  onOpen: (name: string) => void,
) {
  return (
    <div class="plugin-skills-section">
      {PluginCapabilitySection(
        t("pluginsPage.detailTabs.skills"),
        skills.map((skill) => ({ ...skill, onOpen: () => onOpen(skill.name) })),
        () => (
          <Icon name="bookOpenText" />
        ),
      )}
    </div>
  );
}
