import { consume } from "@lit/context";
import type { Question } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { isQuestionThumbnail } from "../../../../../packages/gateway-protocol/src/question-media.js";
import type {
  QuestionResourceAction,
  QuestionResourceActionResult,
} from "../../../../../packages/gateway-protocol/src/question-resource.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import { t } from "../../../i18n/index.ts";
import { bytesToBase64 } from "../../../lib/bytes-base64.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { assertUploadsEnabled } from "../../../lib/uploads.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { admitAttachmentFiles, resolveChatAttachmentLimits } from "./chat-attachment-admission.ts";

/** Local presentation only; the pending question and MCP view own all resource grants. */
class ChatQuestionResource extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ attribute: false }) question?: Question;
  @property({ attribute: false }) requestId = "";
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId?: string;
  @property({ attribute: false }) selected: ReadonlySet<string> = new Set();
  @property({ type: Boolean }) disabled = false;
  @state() private busy = false;
  @state() private error = "";
  @state() private uploaded: Array<{ uri: string; name: string }> = [];
  @state() private preview: { viewId?: string; text?: string; images?: string[] } | null = null;
  private generation = 0;
  private operationAbort?: AbortController;
  private identity = "";
  constructor() {
    super();
    new SubscriptionsController(this).watchStore(() => this.context?.gateway);
  }
  private key() {
    return JSON.stringify([
      this.requestId,
      this.question?.questionId,
      this.question?.resource?.viewId,
      this.sessionKey,
      this.agentId,
      this.context ? gatewayPresentationScope(this.context.gateway).key : -1,
    ]);
  }
  override willUpdate() {
    const identity = this.key();
    if (identity !== this.identity || this.disabled) {
      this.operationAbort?.abort();
      this.generation++;
      if (identity !== this.identity) {
        this.uploaded = [];
      }
      this.identity = identity;
      this.busy = false;
      this.error = "";
      this.preview = null;
    }
  }
  override disconnectedCallback() {
    this.operationAbort?.abort();
    this.generation++;
    super.disconnectedCallback();
  }

  private async operation(action: (isCurrent: () => boolean) => Promise<QuestionResourceAction>) {
    const context = this.context;
    const client = context?.gateway.snapshot.client;
    const question = this.question;
    if (
      !context ||
      context.gateway.snapshot.phase !== "connected" ||
      !client ||
      !question?.resource?.viewId ||
      this.disabled ||
      this.busy ||
      !this.sessionKey
    ) {
      return;
    }
    const generation = ++this.generation;
    const abort = new AbortController();
    this.operationAbort = abort;
    const scope = gatewayPresentationScope(context.gateway).key;
    const identity = this.key();
    const current = () =>
      this.isConnected &&
      !this.disabled &&
      generation === this.generation &&
      identity === this.key() &&
      context.gateway.snapshot.client === client &&
      gatewayPresentationScope(context.gateway).key === scope;
    this.busy = true;
    this.error = "";
    try {
      const request = await action(current);
      if (!current()) {
        return;
      }
      const result = await client.request<QuestionResourceActionResult>(
        "mcp.app.formResource",
        {
          sessionKey: this.sessionKey,
          agentId: this.agentId,
          viewId: question.resource.viewId,
          requestId: this.requestId,
          questionId: question.questionId,
          ...request,
        },
        { signal: abort.signal },
      );
      if (!current()) {
        return;
      }
      if ("resources" in result) {
        if (
          !Array.isArray(result.resources) ||
          result.resources.length > 64 ||
          !result.resources.every(
            (resource) =>
              typeof resource.uri === "string" &&
              resource.uri.length <= 2048 &&
              typeof resource.name === "string",
          )
        ) {
          throw new Error("Invalid resource upload result");
        }
        const uploaded = new Map(
          [...this.uploaded, ...result.resources].map((resource) => [resource.uri, resource]),
        );
        if (uploaded.size > 64 || (!question.multiSelect && result.resources.length !== 1)) {
          throw new Error("Invalid resource upload count");
        }
        this.uploaded = [...uploaded.values()];
        const values = question.multiSelect ? new Set(this.selected) : new Set<string>();
        for (const resource of result.resources) {
          values.add(resource.uri);
        }
        this.dispatchEvent(
          new CustomEvent("resource-selection", {
            detail: { values: [...values] },
            bubbles: true,
            composed: true,
          }),
        );
      } else if ("preview" in result) {
        if (result.preview.viewId) {
          await import("../../../components/mcp-app-view-registration.ts");
          if (!current()) {
            return;
          }
          this.preview = { viewId: result.preview.viewId };
        } else {
          const text = result.preview.contents?.map((entry) => entry.text ?? "").join("\n") ?? "";
          const images = result.preview.contents
            ?.flatMap((entry) => {
              const url =
                entry.blob && entry.mimeType
                  ? `data:${entry.mimeType};base64,${entry.blob}`
                  : undefined;
              return isQuestionThumbnail(url) ? [url] : [];
            })
            .slice(0, 4);
          this.preview = { text: text.slice(0, 65536), images };
        }
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.busy = false;
        this.operationAbort = undefined;
      }
    }
  }

  private async upload(input: HTMLInputElement) {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) {
      return;
    }
    await this.operation(async (current) => {
      assertUploadsEnabled(this.context?.config);
      const limits = resolveChatAttachmentLimits(this.context?.gateway.snapshot.hello?.policy);
      if (
        !limits ||
        files.length + this.uploaded.length > 64 ||
        admitAttachmentFiles(files, limits, 0).length !== files.length
      ) {
        throw new Error(t("chat.questions.resourceUploadTooLarge"));
      }
      const payload: Extract<QuestionResourceAction, { action: "upload" }>["files"] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!current()) {
          throw new Error("Resource upload cancelled");
        }
        assertUploadsEnabled(this.context?.config);
        payload.push({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          content: bytesToBase64(bytes),
          ...(file.webkitRelativePath ? { relativePath: file.webkitRelativePath } : {}),
        });
      }
      return { action: "upload", files: payload };
    });
  }

  override render() {
    const question = this.question;
    const resource = question?.resource;
    if (!question || !resource?.viewId) {
      return nothing;
    }
    return html`
      <div class="chat-question-panel__resource-actions">
        ${question.options.map((option, optionIndex) => (option.preview && (resource.selection !== "implicit" || this.selected.has(option.value ?? option.label)) ? html`<button class="btn btn--sm" type="button" ?disabled=${this.disabled || this.busy} @click=${() => this.operation(async () => ({ action: "preview", optionIndex }))}>${t("chat.questions.resourcePreview")}: ${option.label}</button>` : nothing))}
        ${
          resource.userOptions
            ? html`<label class="field"
                ><span>${question.header}</span
                ><input
                  type="file"
                  aria-label=${question.header}
                  ?multiple=${question.multiSelect || resource.userOptions.kind === "directory"}
                  accept=${ifDefined(resource.userOptions.accept?.join(","))}
                  ?webkitdirectory=${resource.userOptions.kind === "directory"}
                  ?disabled=${this.disabled || this.busy}
                  @change=${(event: Event) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      void this.upload(event.currentTarget);
                    }
                  }}
              /></label>`
            : nothing
        }
        ${this.uploaded.filter((entry) => this.selected.has(entry.uri)).map((entry) => html`<div>${entry.name}<button class="btn btn--sm" type="button" ?disabled=${this.disabled || this.busy} @click=${() => this.dispatchEvent(new CustomEvent("resource-selection", { detail: { values: [...this.selected].filter((value) => value !== entry.uri) }, bubbles: true, composed: true }))}>${t("common.remove")}</button></div>`)}
        ${this.busy ? html`<div role="status">${t("common.loading")}</div>` : nothing}
        ${this.error ? html`<div role="alert">${this.error}</div>` : nothing}
        ${
          this.preview?.viewId
            ? html`<mcp-app-view
                .sessionKey=${this.sessionKey}
                .viewId=${this.preview.viewId}
              ></mcp-app-view>`
            : this.preview
              ? html`${this.preview.images?.map((src) => html`<img class="chat-question-panel__resource-image" src=${src} alt=${question.header} />`)}
                  <pre class="chat-question-panel__resource-preview">${this.preview.text}</pre>`
              : nothing
        }
      </div>
    `;
  }
}
if (!customElements.get("openclaw-chat-question-resource")) {
  customElements.define("openclaw-chat-question-resource", ChatQuestionResource);
}
