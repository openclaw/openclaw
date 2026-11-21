import { Loading, Show, lazy, onSettled } from "solid-js";
import type {
  PluginsSkillsReadParams,
  PluginsSkillsReadResult,
} from "../../../../packages/gateway-protocol/src/schema/plugin-skills.ts";
import "../../components/modal-dialog.tsx";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import "./custom-elements.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { renderPluginCapabilitySection as PluginCapabilitySection } from "./overview.tsx";
import "./skill-preview.css";
import { showPluginToolPreview, type PluginToolPreview } from "./tool-preview.tsx";

registerEnglishCatalog(registerPluginManagementEnglish);

const PluginSkillDocument = lazy(() => import("./skill-preview-document.tsx"), {
  export: "PluginSkillDocument",
});

type SkillRequest =
  | Omit<Extract<PluginsSkillsReadParams, { source: "installed" }>, "path">
  | Omit<Extract<PluginsSkillsReadParams, { source: "catalog" }>, "path">;

type SkillDocument =
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "error"; message: string; retryable: boolean };

type SkillPreviewIdentity = { description?: string; publisher?: string };
const skillSummarySegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
type PluginSkillPreviewState = {
  request: SkillRequest;
  identity?: SkillPreviewIdentity;
  document: SkillDocument;
};

export function createPluginPreview(gateway: Pick<GatewayPageBinding, "capture" | "isCurrent">) {
  // Preview changes must not rerender the invoking row while the modal owns its focus.
  const { owner, view } = projectCallbackOwner(
    (notify) => createPluginPreviewOwner(gateway, notify),
    (preview) => preview.state,
  );
  return Object.assign(owner, { read: view.read });
}

function createPluginPreviewOwner(
  gateway: Pick<GatewayPageBinding, "capture" | "isCurrent">,
  onChange: () => void,
) {
  let active: PluginSkillPreviewState | null = null;
  let toolAbort = new AbortController();
  onSettled(() => () => {
    active = null;
    toolAbort.abort();
  });
  const preview = {
    get state() {
      return active;
    },
    async open(request: SkillRequest, identity?: SkillPreviewIdentity): Promise<void> {
      toolAbort.abort();
      toolAbort = new AbortController();
      const pending: PluginSkillPreviewState = {
        request,
        identity,
        document: { status: "loading" },
      };
      active = pending;
      onChange();
      const connection = gateway.capture();
      let skill: SkillDocument;
      let selected = request;
      if (!connection) {
        skill = { status: "error", message: t("pluginsPage.connectToManage"), retryable: true };
      } else {
        try {
          // Omitting path reads the declared entry body, without reading sibling bodies.
          const result = await connection.client.request<PluginsSkillsReadResult>(
            "plugins.skills.read",
            request,
          );
          const entry = result.files.find((file) => file.path === result.entryPath);
          if (result.version) {
            selected = { ...request, version: result.version };
          }
          if (entry?.status === "ready" && entry.content !== undefined) {
            skill = { status: "ready", content: entry.content };
          } else {
            const tooLarge = entry?.status === "too-large";
            skill = {
              status: "error",
              message: t(
                tooLarge
                  ? "pluginsPage.skillPreview.tooLarge"
                  : "pluginsPage.skillPreview.unavailable",
              ),
              retryable: !tooLarge,
            };
          }
        } catch (error) {
          skill = { status: "error", message: formatUiError(error), retryable: true };
        }
      }
      if (active === pending && (!connection || gateway.isCurrent(connection))) {
        active = { request: selected, identity, document: skill };
        onChange();
      }
    },

    openTool(tool: PluginToolPreview): void {
      preview.close();
      void showPluginToolPreview(tool, toolAbort.signal);
    },

    retry(): void {
      if (active?.document.status === "error" && active.document.retryable) {
        void preview.open(active.request, active.identity);
      }
    },

    /** Dismissal, route changes and connection changes retire outstanding reads. */
    close(this: void): void {
      active = null;
      toolAbort.abort();
      toolAbort = new AbortController();
      onChange();
    },
  };
  return preview;
}

export function PluginSkillPreview(props: {
  preview: ReturnType<typeof createPluginPreviewOwner>;
  state: PluginSkillPreviewState | null;
}) {
  return (
    <Show when={props.state}>
      {(state) => {
        const skill = () => state().document;
        const error = () => {
          const current = skill();
          return current.status === "error" ? current : undefined;
        };
        const document = () => {
          const current = skill();
          return current.status === "ready" ? current : undefined;
        };
        const close = () => props.preview.close();
        const summary = () => {
          const description = state().identity?.description?.trim();
          if (!description) {
            return undefined;
          }
          for (const { segment } of skillSummarySegmenter.segment(description)) {
            return segment.trim();
          }
          return undefined;
        };
        return (
          <openclaw-modal-dialog
            label={state().request.skillName}
            style={{ "--openclaw-modal-width": "680px" }}
            onModal-cancel={close}
          >
            <div
              class="oc-dialog"
              style={{
                height: "min(660px, 82dvh, var(--openclaw-modal-height-limit))",
                "overflow-wrap": "anywhere",
              }}
            >
              <header
                class="oc-dialog__header"
                style={{
                  "align-items": "start",
                  margin: "0 var(--overlay-modal-padding)",
                  padding: "18px 0 14px",
                  "border-block-end": "1px solid var(--border)",
                }}
              >
                <div class="plugin-catalog-row__main" style={{ gap: "12px" }}>
                  <span
                    class="plugin-capability__icon"
                    aria-hidden="true"
                    style={{
                      width: "40px",
                      height: "40px",
                      flex: "none",
                      border: "0",
                      "border-radius": "calc(10px * var(--openclaw-corner-radius-scale))",
                      background: "color-mix(in srgb, var(--text) 5%, transparent)",
                      color: "var(--muted)",
                    }}
                  >
                    <Icon name="bookOpenText" />
                  </span>
                  <div class="plugin-catalog-row__text" style={{ gap: "3px" }}>
                    <div
                      class="plugin-card-title-row"
                      style={{ "flex-wrap": "wrap", gap: "2px 8px" }}
                    >
                      <h2
                        class="oc-dialog__title"
                        style={{
                          "font-size": "var(--control-ui-text-lg)",
                          "min-height": "0",
                          "line-height": "1.2",
                        }}
                      >
                        {state().request.skillName}
                      </h2>
                      <Show when={state().identity?.publisher}>
                        {(publisher) => <span class="plugin-card-author">@{publisher()}</span>}
                      </Show>
                    </div>
                    <Show when={summary()}>
                      {(description) => (
                        <p
                          class="installed-plugins-card__summary"
                          style={{ "min-height": "0", "line-height": "1.35", overflow: "hidden" }}
                        >
                          {description()}
                        </p>
                      )}
                    </Show>
                  </div>
                </div>
                <IconButton
                  size={28}
                  class="oc-dialog__close"
                  icon="x"
                  label={t("common.close")}
                  tooltip={false}
                  onClick={close}
                />
              </header>
              <div
                class="oc-dialog__body plugin-skill-dialog__body"
                aria-busy={skill().status === "loading" ? "true" : "false"}
              >
                <Show when={skill().status === "loading"}>
                  <PanelLoadingSkeleton variant="document" label={t("common.loading")} compact />
                </Show>
                <Show when={error()}>
                  {(failure) => (
                    <InlineAlert tone="danger" role="alert">
                      {failure().message}
                    </InlineAlert>
                  )}
                </Show>
                <Show when={document()}>
                  {(ready) => (
                    <Loading
                      fallback={
                        <PanelLoadingSkeleton
                          variant="document"
                          label={t("common.loading")}
                          compact
                        />
                      }
                    >
                      <PluginSkillDocument content={ready().content} />
                    </Loading>
                  )}
                </Show>
              </div>
              <Show when={error()?.retryable}>
                <openclaw-modal-actions class="oc-dialog__footer">
                  <button type="button" class="btn" onClick={() => props.preview.retry()}>
                    {t("common.retry")}
                  </button>
                </openclaw-modal-actions>
              </Show>
            </div>
          </openclaw-modal-dialog>
        );
      }}
    </Show>
  );
}

export function renderPluginSkillsSection(
  skills: ReadonlyArray<{ name: string; description?: string }>,
  onOpen: (skill: { name: string; description?: string }) => void,
) {
  return (
    <div class="plugin-skills-section">
      {PluginCapabilitySection(
        t("pluginsPage.detailTabs.skills"),
        skills.map((skill) => ({ ...skill, onOpen: () => onOpen(skill) })),
        () => (
          <Icon name="bookOpenText" />
        ),
      )}
    </div>
  );
}
