import { createMemo, onCleanup } from "solid-js";
import type {
  PluginsSkillsReadParams,
  PluginsSkillsReadResult,
} from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
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

export function createPluginPreview(
  gateway: Pick<GatewayPageBinding, "capture" | "isCurrent">,
  onChange: () => void,
) {
  let active: PluginSkillPreviewState | null = null;
  let toolAbort = new AbortController();
  onCleanup(() => {
    toolAbort.abort();
    active = null;
  });
  const preview = {
    get state() {
      return active;
    },
    async open(request: PluginsSkillsReadParams): Promise<void> {
      preview.close();
      const connection = gateway.capture();
      const state: PluginSkillPreviewState = {
        request: { ...request },
        loading: Boolean(connection),
        error: connection ? null : t("pluginsPage.connectToManage"),
        result: null,
        activePath: "SKILL.md",
        pendingPaths: new Set(),
        fileErrors: new Map(),
      };
      active = state;
      onChange();
      if (!connection) {
        return;
      }
      const current = () => active === state && gateway.isCurrent(connection);
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
          onChange();
        }
      }
    },

    openTool(tool: PluginToolPreview): void {
      preview.close();
      void showPluginToolPreview(tool, toolAbort.signal);
    },

    retry(): void {
      if (active?.result) {
        void preview.select(active.activePath);
      } else if (active) {
        void preview.open(active.request);
      }
    },
    async select(path: string): Promise<void> {
      const state = active;
      const file = state?.result?.files.find((candidate) => candidate.path === path);
      if (!state || !file) {
        return;
      }
      state.activePath = path;
      onChange();
      if (
        state.pendingPaths.has(path) ||
        (file.status !== "deferred" && file.status !== "unavailable")
      ) {
        return;
      }
      const connection = gateway.capture();
      if (!connection) {
        state.fileErrors.set(path, t("pluginsPage.connectToManage"));
        return;
      }
      const current = () => active === state && gateway.isCurrent(connection);
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
          onChange();
        }
      }
    },
    /** Dismissal, route changes and connection changes retire outstanding reads. */
    close(this: void): void {
      toolAbort.abort();
      toolAbort = new AbortController();
      active = null;
      onChange();
    },
  };
  return preview;
}

export function PluginSkillPreview(props: {
  preview: ReturnType<typeof createPluginPreview>;
  state: PluginSkillPreviewState | null;
}) {
  const state = () => props.state;
  const files = createMemo(
    () =>
      state()?.result?.files.map((file) => ({
        path: file.path,
        size: "",
        contents: file.content ?? "",
        message:
          file.status !== "ready" && file.status !== "deferred"
            ? t(`filePreview.bundle.${file.status}`)
            : undefined,
      })) ?? [],
  );
  const fileError = createMemo(() => {
    const current = state();
    const file = current?.result?.files.find((entry) => entry.path === current.activePath);
    return (
      current?.fileErrors.get(current.activePath) ??
      (file?.status === "unavailable" ? t("filePreview.bundle.unavailable") : "")
    );
  });
  const incomplete = createMemo(() => {
    const result = state()?.result;
    return (
      result &&
      (!result.inventoryComplete ||
        result.files.some((file) => file.status === "unavailable" || file.status === "too-large"))
    );
  });
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
            void props.preview.select(event.detail)
          }
          onFile-preview-retry={() => props.preview.retry()}
          onFile-preview-close={() => props.preview.close()}
        />
      )}
    </>
  );
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
