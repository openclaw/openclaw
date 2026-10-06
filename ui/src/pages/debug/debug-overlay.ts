import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state as litState } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  isOptionalElementDefined,
  LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "../../app/lazy-custom-element.ts";
import {
  clearLazyShellAction,
  persistLazyShellAction,
  readLazyShellAction,
} from "../../app/lazy-shell-action.ts";
import { retryStaleChunkReloadWhenReachable } from "../../app/stale-chunk-reload.ts";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { DEBUG_OVERLAY_REQUEST_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  renderDebugOverlayFrame,
  renderDebugOverlayLoading,
  shouldCloseDebugOverlay,
  type DebugOverlayMode,
} from "./debug-overlay-frame.ts";

const DEBUG_OVERLAY_CONTENT = {
  tagName: "openclaw-debug-overlay-content",
  get label() {
    return t("debug.overlay.title");
  },
  loadModule: () => import("./debug-overlay-content.ts"),
} satisfies OptionalCustomElement;

export class DebugOverlay extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @litState() private mode: "closed" | "expanded" | "minimized" = "closed";

  private contentKey = 0;
  private recoveryActionPending = false;
  private readonly content = new LazyCustomElementRequestController(this, undefined, (canReload) =>
    retryStaleChunkReloadWhenReachable({
      canReload: () => {
        if (!canReload()) {
          return false;
        }
        this.recoveryActionPending = persistLazyShellAction({
          eventType: DEBUG_OVERLAY_REQUEST_EVENT,
        });
        return this.recoveryActionPending;
      },
    }),
  );

  override disconnectedCallback(): void {
    this.close();
    super.disconnectedCallback();
  }

  toggle(): void {
    if (this.mode === "minimized") {
      this.mode = "expanded";
      return;
    }
    if (this.mode === "expanded") {
      this.close();
      return;
    }
    this.open("expanded");
  }

  open(mode: DebugOverlayMode): void {
    if (this.mode !== "closed") {
      this.mode = mode;
      return;
    }
    this.mode = mode;
    this.contentKey += 1;
    document.addEventListener("keydown", this.handleKeydown, true);
    if (!isOptionalElementDefined(DEBUG_OVERLAY_CONTENT)) {
      // Automatic stale-chunk reloads can happen before the manual Retry path.
      this.recoveryActionPending = persistLazyShellAction({
        eventType: DEBUG_OVERLAY_REQUEST_EVENT,
      });
      this.content.request(DEBUG_OVERLAY_CONTENT, () => this.clearRecoveryAction());
    }
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (!shouldCloseDebugOverlay(event, this.mode, this)) {
      return;
    }
    event.preventDefault();
    this.close();
  };

  private readonly close = (): void => {
    this.mode = "closed";
    document.removeEventListener("keydown", this.handleKeydown, true);
    this.content.close();
    this.clearRecoveryAction();
  };

  private clearRecoveryAction(): void {
    if (!this.recoveryActionPending) {
      return;
    }
    if (readLazyShellAction()?.eventType === DEBUG_OVERLAY_REQUEST_EVENT) {
      clearLazyShellAction();
    }
    this.recoveryActionPending = false;
  }

  private renderContent() {
    const loadState = this.content.visibleState;
    if (loadState?.status === "error") {
      return renderLazyViewError({
        actionLabel: t("common.retry"),
        error: loadState.error,
        stale: loadState.stale,
        subtitle: loadState.element.label,
        onRetry: () => this.content.retry(),
      });
    }
    if (!isOptionalElementDefined(DEBUG_OVERLAY_CONTENT)) {
      return renderDebugOverlayLoading(this.mode);
    }
    return keyed(
      this.contentKey,
      html`<openclaw-debug-overlay-content
        .context=${this.context}
        .minimized=${this.mode === "minimized"}
      ></openclaw-debug-overlay-content>`,
    );
  }

  override render() {
    if (this.mode === "closed") {
      return nothing;
    }
    return renderDebugOverlayFrame({
      mode: this.mode,
      body: this.renderContent(),
      onToggleMode: () => {
        this.mode = this.mode === "minimized" ? "expanded" : "minimized";
      },
      onClose: this.close,
    });
  }
}

if (!customElements.get("openclaw-debug-overlay")) {
  customElements.define("openclaw-debug-overlay", DebugOverlay);
}
