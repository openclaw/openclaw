import { createComponent, insert, render as renderSolid, spread } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import type { CronScratchGetResult, CronScratchSetResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { i18n, t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";

registerCronEnglish();

class CronScratchEditor extends HTMLElement {
  private currentJobId = "";
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private unsubscribeGateway?: () => void;
  private unsubscribeLocale?: () => void;
  private bindingRevision = 0;
  private snapshot: CronScratchGetResult | null = null;
  private draft = "";
  private busy = false;
  private message = "";
  private conflict = false;
  private redacted = false;
  private readonly projection = createSignal(0, { ownedWrite: true });
  private disposePresentation?: () => void;
  private readonly connection = createGatewayConnectionLifecycle({
    client: null,
    phase: "stopped",
  });

  get jobId() {
    return this.currentJobId;
  }

  set jobId(value: string) {
    if (value === this.currentJobId) {
      return;
    }
    this.currentJobId = value;
    this.connection.invalidate();
    this.reset();
  }

  get gateway() {
    return this.gatewaySource;
  }

  set gateway(value: ApplicationContext["gateway"] | null) {
    if (value === this.gatewaySource) {
      return;
    }
    this.gatewaySource = value;
    this.bindGateway();
  }

  connectedCallback() {
    this.bindGateway();
    this.unsubscribeLocale = i18n.subscribe(() => this.publish());
    this.disposePresentation = renderSolid(() => this.renderContent(), this);
  }

  disconnectedCallback() {
    this.bindingRevision += 1;
    this.unsubscribeGateway?.();
    this.unsubscribeGateway = undefined;
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = undefined;
    this.connection.transition({ client: null, phase: "stopped" });
    this.reset();
    this.disposePresentation?.();
    this.disposePresentation = undefined;
  }

  private publish() {
    this.projection[1]((revision) => revision + 1);
  }

  private bindGateway() {
    const bindingRevision = ++this.bindingRevision;
    this.unsubscribeGateway?.();
    this.unsubscribeGateway = undefined;
    this.connection.invalidate();
    this.reset();
    const gateway = this.gatewaySource;
    if (!this.isConnected || !gateway) {
      this.connection.transition({ client: null, phase: "stopped" });
      return;
    }
    this.applySnapshot(gateway.snapshot);
    this.unsubscribeGateway = gateway.subscribe((snapshot) => {
      if (bindingRevision === this.bindingRevision && gateway === this.gatewaySource) {
        this.applySnapshot(snapshot);
      }
    });
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    if (this.connection.transition(snapshot)) {
      this.reset();
    }
    if (!this.canManage) {
      this.connection.invalidate();
      this.reset();
    }
    this.publish();
  }

  private reset() {
    this.snapshot = null;
    this.draft = "";
    this.busy = false;
    this.message = "";
    this.conflict = false;
    this.redacted = false;
    this.publish();
  }

  private get canManage() {
    return Boolean(
      this.gatewaySource && readGatewayOperatorAccess(this.gatewaySource.snapshot).canAdmin,
    );
  }

  private get sizeBytes() {
    return new TextEncoder().encode(this.draft).length;
  }

  private accept(snapshot: CronScratchGetResult) {
    const content = snapshot.scratch?.content ?? "";
    this.draft = redactToolDetail(content);
    this.redacted = this.draft !== content;
    // Retain revision metadata only: raw scratch must not leak into diagnostics/state dumps.
    this.snapshot = {
      ...snapshot,
      scratch: snapshot.scratch ? { ...snapshot.scratch, content: "" } : null,
    };
    this.conflict = false;
  }

  private async request(content?: string | null) {
    const scope = this.connection.capture();
    const client = scope?.client;
    const jobId = this.jobId;
    const saving = content !== undefined;
    const snapshot = this.snapshot;
    if (!scope || !client || !jobId || this.busy || !this.canManage) {
      return;
    }
    if (saving && (!this.canManage || !snapshot || this.conflict)) {
      return;
    }
    if (typeof content === "string" && this.redacted) {
      return;
    }
    if (typeof content === "string" && snapshot && this.sizeBytes > snapshot.maxBytes) {
      this.message = t("cron.scratch.tooLarge");
      this.publish();
      return;
    }
    this.busy = true;
    this.message = "";
    this.publish();
    try {
      const result = saving
        ? await client.request<CronScratchSetResult>("cron.scratch.set", {
            id: jobId,
            content,
            expectedRevision: snapshot?.currentRevision,
          })
        : await client.request<CronScratchGetResult>("cron.scratch.get", { id: jobId });
      if (!this.connection.isCurrent(scope) || this.jobId !== jobId || !this.canManage) {
        return;
      }
      if ("reason" in result) {
        // Never adopt the conflicting revision while retaining an older draft: a retry would overwrite it.
        this.conflict = true;
        this.message = t("cron.scratch.conflict");
        return;
      }
      this.accept(result);
      if (saving) {
        this.message = t(content === null ? "cron.scratch.removed" : "cron.scratch.saved");
      }
    } catch (error) {
      if (this.connection.isCurrent(scope) && this.jobId === jobId) {
        this.message = formatUiError(error);
      }
    } finally {
      if (this.connection.isCurrent(scope) && this.jobId === jobId) {
        this.busy = false;
        this.publish();
      }
    }
  }

  private renderContent() {
    // Request fields remain synchronous; Solid only projects the admitted view.
    const view = createMemo(() => {
      this.projection[0]();
      return {
        canManage: this.canManage,
        snapshot: this.snapshot,
        draft: this.draft,
        busy: this.busy,
        connected: this.gatewaySource?.snapshot.phase === "connected",
        disabled:
          this.busy ||
          this.gatewaySource?.snapshot.phase !== "connected" ||
          !this.canManage ||
          this.conflict,
        redacted: this.redacted,
        sizeBytes: this.sizeBytes,
        message: this.message,
      };
    });
    const text: typeof t = (key, params) => {
      this.projection[0]();
      return t(key, params);
    };
    const help = (content: () => string) => {
      const paragraph = document.createElement("p");
      paragraph.className = "cron-help";
      insert(paragraph, content);
      return paragraph;
    };
    const button = (
      label: () => string,
      disabled: () => boolean,
      onClick: () => void,
      danger = false,
    ) => {
      const element = document.createElement("button");
      element.className = danger ? "btn btn--sm danger" : "btn btn--sm";
      element.type = "button";
      spread(
        element,
        {
          get "prop:disabled"() {
            return disabled();
          },
          onClick,
        },
        true,
      );
      insert(element, label);
      return element;
    };
    // Show's accessor callbacks own the subtrees, retaining input DOM through field updates.
    return createComponent(Show, {
      get when() {
        return view().canManage;
      },
      children: (_visible) => {
        const section = document.createElement("section");
        section.className = "settings-section";
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.className = "settings-section__heading";
        insert(summary, () => text("cron.scratch.title"));
        const description = document.createElement("p");
        description.className = "settings-section__desc";
        insert(description, () => text("cron.scratch.help"));
        details.append(
          summary,
          description,
          button(
            () => text(view().snapshot ? "cron.scratch.reload" : "cron.scratch.load"),
            () => view().busy || !view().connected,
            () => void this.request(),
          ),
        );
        insert(
          details,
          createComponent(Show, {
            get when() {
              return view().snapshot !== null;
            },
            children: (_loaded) => {
              const label = document.createElement("label");
              label.className = "field";
              const caption = document.createElement("span");
              insert(caption, () => text("cron.scratch.content"));
              const textarea = document.createElement("textarea");
              textarea.className = "settings-input mono";
              textarea.rows = 8;
              spread(
                textarea,
                {
                  get "prop:value"() {
                    return view().draft;
                  },
                  get "prop:readOnly"() {
                    return view().disabled || view().redacted;
                  },
                  get "prop:maxLength"() {
                    return view().snapshot?.maxBytes;
                  },
                  onInput: () => {
                    this.draft = textarea.value;
                    this.publish();
                  },
                },
                true,
              );
              label.append(caption, textarea);
              return [
                createComponent(Show, {
                  get when() {
                    return !view().snapshot?.scratch;
                  },
                  children: (_empty) => help(() => text("cron.scratch.empty")),
                }),
                label,
                help(() =>
                  text("cron.scratch.limit", {
                    bytes: String(view().sizeBytes),
                    max: String(view().snapshot?.maxBytes),
                  }),
                ),
                createComponent(Show, {
                  get when() {
                    return view().redacted;
                  },
                  children: (_redacted) => help(() => text("cron.scratch.redacted")),
                }),
                button(
                  () => text("cron.scratch.save"),
                  () =>
                    view().disabled ||
                    view().redacted ||
                    view().sizeBytes > (view().snapshot?.maxBytes ?? 0),
                  () => void this.request(this.draft),
                ),
                document.createTextNode(" "),
                button(
                  () => text("cron.scratch.clear"),
                  () => view().disabled || !view().snapshot?.scratch,
                  () => void this.request(null),
                  true,
                ),
              ];
            },
          }),
          null,
        );
        const status = help(() => view().message);
        status.setAttribute("role", "status");
        insert(details, () => (view().message ? status : null), null);
        section.append(details);
        return section;
      },
    });
  }
}

if (!customElements.get("openclaw-cron-scratch-editor")) {
  customElements.define("openclaw-cron-scratch-editor", CronScratchEditor);
}
