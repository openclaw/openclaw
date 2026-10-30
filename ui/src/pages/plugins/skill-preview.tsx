import { createMemo, onSettled } from "solid-js";
import type {
  PluginsSkillsReadParams,
  PluginsSkillsReadResult,
} from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
import { FilePreviewModal } from "../../components/file-preview-modal.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerFilePreviewEnglish } from "../../i18n/locales/en-file-preview.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUiError, UserFacingError } from "../../lib/format-error.ts";
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
  inventoryRequest: Promise<void>;
  result: PluginsSkillsReadResult | null;
  activePath: string;
  fileRequests: Map<string, { promise: Promise<void>; resolve: () => void; active: boolean }>;
};

export function createPluginPreview(
  gateway: Pick<GatewayPageBinding, "capture" | "isCurrent">,
  onChange: () => void,
) {
  let active: PluginSkillPreviewState | null = null;
  let toolAbort = new AbortController();
  let releaseInventory = () => {};
  const retire = () => {
    // Release presentation even when a retired transport read remains pending.
    releaseInventory();
    for (const request of active?.fileRequests.values() ?? []) {
      request.resolve();
    }
    toolAbort.abort();
    active = null;
  };
  onSettled(() => retire);
  const preview = {
    get state() {
      return active;
    },
    async open(request: PluginsSkillsReadParams): Promise<void> {
      preview.close();
      const connection = gateway.capture();
      const receipt = Promise.withResolvers<void>();
      releaseInventory = receipt.resolve;
      void receipt.promise.catch(() => {});
      const state: PluginSkillPreviewState = {
        request: { ...request },
        inventoryRequest: receipt.promise,
        result: null,
        activePath: "SKILL.md",
        fileRequests: new Map(),
      };
      active = state;
      onChange();
      if (!connection) {
        receipt.reject(new UserFacingError(t("pluginsPage.connectToManage")));
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
          receipt.reject(new UserFacingError(formatUiError(error), { cause: error }));
        }
      } finally {
        if (current()) {
          onChange();
        }
        receipt.resolve();
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
        state.fileRequests.get(path)?.active ||
        (file.status !== "deferred" && file.status !== "unavailable")
      ) {
        return;
      }
      const receipt = Promise.withResolvers<void>();
      void receipt.promise.catch(() => {});
      const request = { promise: receipt.promise, resolve: receipt.resolve, active: true };
      state.fileRequests.set(path, request);
      onChange();
      const connection = gateway.capture();
      if (!connection) {
        request.active = false;
        receipt.reject(new UserFacingError(t("pluginsPage.connectToManage")));
        return;
      }
      const current = () => active === state && gateway.isCurrent(connection);
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
        if (selected.status === "unavailable") {
          throw new UserFacingError(t("filePreview.bundle.unavailable"));
        }
      } catch (error) {
        if (current()) {
          receipt.reject(new UserFacingError(formatUiError(error), { cause: error }));
        }
      } finally {
        if (current()) {
          request.active = false;
          onChange();
        }
        receipt.resolve();
      }
    },
    /** Dismissal, route changes and connection changes retire outstanding reads. */
    close(this: void): void {
      retire();
      toolAbort = new AbortController();
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
  const readInventory = createMemo(() => state()?.inventoryRequest ?? null);
  const fileRequest = () => {
    const current = state();
    return current?.fileRequests.get(current.activePath)?.promise ?? current?.inventoryRequest;
  };
  const readFile = createMemo(() => {
    const current = state();
    const request = current?.fileRequests.get(current.activePath)?.promise;
    if (request) {
      return request;
    }
    const file = current?.result?.files.find((entry) => entry.path === current.activePath);
    if (file?.status === "unavailable") {
      throw new UserFacingError(t("filePreview.bundle.unavailable"));
    }
    return current?.inventoryRequest ?? null;
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
        <FilePreviewModal
          label={props.state.request.skillName}
          files={files()}
          directories={props.state.result?.directories ?? []}
          activePath={props.state.activePath}
          layout="document"
          readInventory={readInventory}
          inventoryRequest={() => props.state?.inventoryRequest}
          readFile={readFile}
          fileRequest={fileRequest}
          notice={incomplete() ? t("filePreview.bundle.incomplete") : ""}
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
