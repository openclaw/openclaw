import type { ReactiveController, ReactiveControllerHost } from "lit";
import { html, nothing } from "lit";
import { Value } from "typebox/value";
import {
  SupervisionArtifactResultSchema,
  SupervisionControlResultSchema,
  SupervisionListResultSchema,
  type SupervisionArtifactResult,
  type SupervisionControlParams,
  type SupervisionSummary,
} from "../../../../packages/gateway-protocol/src/schema/tasks-supervision.js";
import type { ApplicationContext } from "../../app/context.ts";
import { renderSettingsRow, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { downloadBytesFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";

/** Display-only polling is not task custody. Disconnect/source replacement
 * invalidates responses and every displayed lease expires locally. */
export class SupervisionPanelController implements ReactiveController {
  private sessionKey = "";
  private tasks: SupervisionSummary[] = [];
  private selected: SupervisionSummary | null = null;
  private artifact: SupervisionArtifactResult | null = null;
  private fileBytes: Uint8Array<ArrayBuffer> | null = null;
  private fileName = "";
  private error = "";
  private busy = false;
  private input = "";
  private minutes = 60;
  private attempts = 4;
  private attemptSeconds = 120;
  private next: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private gatewayEpoch = -1;
  private scopeId: string | null | undefined;
  constructor(
    private host: ReactiveControllerHost,
    private context: () => ApplicationContext,
    private gateway: GatewayPageController,
  ) {
    host.addController(this);
  }
  hostConnected() {
    this.timer = setInterval(() => {
      this.host.requestUpdate();
      if (this.sessionKey && !this.busy && !this.next) {
        void this.refresh();
      }
    }, 5000);
  }
  hostDisconnected() {
    clearInterval(this.timer);
    this.reset();
  }
  hostUpdate() {
    const scopeId = this.context()?.agentSelection.state.scopeId;
    if (this.gatewayEpoch !== this.gateway.epoch || scopeId !== this.scopeId) {
      this.gatewayEpoch = this.gateway.epoch;
      this.scopeId = scopeId;
      this.reset();
    }
  }
  private reset() {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    this.tasks = [];
    this.selected = null;
    this.sessionKey = "";
    this.next = undefined;
    this.busy = false;
    this.error = "";
    this.input = "";
    this.artifact = null;
    this.fileBytes = null;
    this.fileName = "";
  }
  private async refresh(after?: string) {
    const scope = this.gateway.capture();
    const source = this.sessionKey;
    const agentId = parseAgentSessionKey(source)?.agentId;
    if (!scope || !agentId || this.busy) {
      return;
    }
    const generation = ++this.generation;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.busy = true;
    this.error = "";
    this.host.requestUpdate();
    try {
      const result = await scope.client.request(
        "tasks.supervision.list",
        { agentId, sessionKey: source, limit: 100, ...(after ? { after } : {}) },
        { signal: abort.signal },
      );
      if (!this.gateway.isCurrent(scope) || generation !== this.generation) {
        return;
      }
      if (!Value.Check(SupervisionListResultSchema, result)) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      this.tasks = after ? [...this.tasks, ...result.tasks] : result.tasks;
      this.next = result.next;
      // Details remain pinned to the reviewed revision until explicitly reopened.
      // A live refresh must not substitute different bytes beneath an approval.
      if (this.selected && !this.tasks.some((task) => task.flowId === this.selected?.flowId)) {
        this.selected = null;
        this.artifact = null;
        this.fileBytes = null;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && generation === this.generation) {
        this.error = formatUiError(error, t("tasksPage.loadFailed"));
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.host.requestUpdate();
      }
    }
  }
  private async control(task: SupervisionSummary, action: SupervisionControlParams["action"]) {
    const scope = this.gateway.capture();
    if (!scope || this.busy || !this.gateway.connected) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    this.host.requestUpdate();
    try {
      const payload = await scope.client.request("tasks.supervision.control", {
        flowId: task.flowId,
        episode: task.episode,
        revision: task.revision,
        inputId: crypto.randomUUID(),
        action,
      });
      if (!this.gateway.isCurrent(scope) || generation !== this.generation) {
        return;
      }
      if (
        !Value.Check(SupervisionControlResultSchema, payload) ||
        payload.acknowledgement.flowId !== task.flowId ||
        payload.currentTask.flowId !== task.flowId
      ) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      this.tasks = this.tasks.map((current) =>
        current.flowId === task.flowId ? payload.currentTask : current,
      );
      // Controls acknowledge their original revision; details display the
      // separately supplied current observation, including later controls.
      this.selected = payload.currentTask;
      this.input = "";
    } catch (error) {
      if (this.gateway.isCurrent(scope) && generation === this.generation) {
        this.error = formatUiError(error, t("tasksPage.supervision.controlFailed"));
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.host.requestUpdate();
      }
    }
  }
  private async inspectArtifact(task: SupervisionSummary, path?: string, after?: string) {
    const scope = this.gateway.capture();
    const selected = task.artifact;
    if (!scope || !selected || this.busy) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    this.host.requestUpdate();
    try {
      let offset = 0;
      let complete: Uint8Array<ArrayBuffer> | null = null;
      let digest = "";
      for (let page = 0; page < 129; page++) {
        const payload = await scope.client.request("tasks.supervision.artifact", {
          flowId: task.flowId,
          ...selected,
          ...(path ? { path, offset } : {}),
          ...(after ? { after } : {}),
        });
        if (!this.gateway.isCurrent(scope) || generation !== this.generation) {
          return;
        }
        if (
          !Value.Check(SupervisionArtifactResultSchema, payload) ||
          payload.sourceHash !== selected.sourceHash ||
          payload.versionId !== selected.versionId
        ) {
          throw new Error(t("tasksPage.invalidResponse"));
        }
        if (!path) {
          this.artifact =
            after && this.artifact
              ? { ...payload, files: [...this.artifact.files, ...payload.files] }
              : payload;
          break;
        }
        const file = payload.file;
        if (
          !file ||
          file.path !== path ||
          file.offset !== offset ||
          (digest && digest !== file.sha256)
        ) {
          throw new Error(t("tasksPage.invalidResponse"));
        }
        complete ??= new Uint8Array(file.bytes);
        digest = file.sha256;
        const chunk = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
        if (
          complete.length !== file.bytes ||
          offset + chunk.length > complete.length ||
          (!chunk.length && offset < complete.length)
        ) {
          throw new Error(t("tasksPage.invalidResponse"));
        }
        complete.set(chunk, offset);
        offset += chunk.length;
        if (file.nextOffset === undefined) {
          if (offset !== complete.length) {
            throw new Error(t("tasksPage.invalidResponse"));
          }
          const actual = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", complete)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          if (!this.gateway.isCurrent(scope) || generation !== this.generation) {
            return;
          }
          if (actual !== digest) {
            throw new Error(t("tasksPage.invalidResponse"));
          }
          this.fileBytes = complete;
          this.fileName = path;
          break;
        }
        if (file.nextOffset !== offset) {
          throw new Error(t("tasksPage.invalidResponse"));
        }
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && generation === this.generation) {
        this.error = formatUiError(error, t("tasksPage.loadFailed"));
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.host.requestUpdate();
      }
    }
  }
  private controls(task: SupervisionSummary, canWrite: boolean) {
    if (task.phase === "quarantined") {
      return nothing;
    }
    const active = ["ready", "running", "waiting"].includes(task.phase);
    const disabled = this.busy || !this.gateway.connected;
    return html`
      ${canWrite && active ? html`<button class="btn" ?disabled=${disabled} @click=${() => void this.control(task, { kind: "cancel" })}>${t("common.cancel")}</button>` : nothing}
      ${
        canWrite && (active || task.phase === "input_required")
          ? html`
              <label class="field"
                ><span>${t("tasksPage.supervision.input")}</span>
                <textarea
                  maxlength="4096"
                  .value=${this.input}
                  @input=${(event: Event) => {
                    this.input = (event.target as HTMLTextAreaElement).value;
                    this.host.requestUpdate();
                  }}
                ></textarea>
              </label>
              ${
                active
                  ? html`<button
                      class="btn"
                      ?disabled=${disabled || !this.input.trim()}
                      @click=${() => void this.control(task, { kind: "steer", input: this.input.trim() })}
                    >
                      ${t("tasksPage.supervision.steer")}
                    </button>`
                  : html`
                      <label class="field"
                        ><span>${t("tasksPage.supervision.minutes")}</span
                        ><input
                          type="number"
                          min="1"
                          max="1440"
                          .value=${String(this.minutes)}
                          @input=${(e: Event) => {
                            this.minutes = Number((e.target as HTMLInputElement).value);
                            this.host.requestUpdate();
                          }}
                      /></label>
                      <label class="field"
                        ><span>${t("tasksPage.supervision.attempts")}</span
                        ><input
                          type="number"
                          min="1"
                          max="100"
                          .value=${String(this.attempts)}
                          @input=${(e: Event) => {
                            this.attempts = Number((e.target as HTMLInputElement).value);
                            this.host.requestUpdate();
                          }}
                      /></label>
                      <label class="field"
                        ><span>${t("tasksPage.supervision.attemptSeconds")}</span
                        ><input
                          type="number"
                          min="1"
                          max="3600"
                          .value=${String(this.attemptSeconds)}
                          @input=${(e: Event) => {
                            this.attemptSeconds = Number((e.target as HTMLInputElement).value);
                            this.host.requestUpdate();
                          }}
                      /></label>
                      <button
                        class="btn"
                        ?disabled=${disabled || !this.input.trim() || !Number.isInteger(this.minutes) || this.minutes < 1 || this.minutes > 1440 || !Number.isInteger(this.attempts) || this.attempts < 1 || this.attempts > 100 || !Number.isInteger(this.attemptSeconds) || this.attemptSeconds < 1 || this.attemptSeconds > 3600}
                        @click=${() => void this.control(task, { kind: "resume", input: this.input.trim(), policy: { deadlineAt: Date.now() + this.minutes * 60_000, maxAttempts: this.attempts, attemptTimeoutMs: this.attemptSeconds * 1000 } })}
                      >
                        ${t("tasksPage.supervision.resume")}
                      </button>
                    `
              }
            `
          : nothing
      }
      ${
        task.artifact
          ? html`<button
                class="btn"
                ?disabled=${disabled}
                @click=${() => void this.inspectArtifact(task)}
              >
                ${t("tasksPage.supervision.inspectArtifact")}
              </button>
              ${
                this.artifact?.sourceHash === task.artifact.sourceHash
                  ? html`
                      ${this.artifact.files.map((file) => html`<button class="btn" ?disabled=${disabled} @click=${() => void this.inspectArtifact(task, file.path)}>${file.path}</button>`)}
                      ${this.artifact.next ? html`<button class="btn" ?disabled=${disabled} @click=${() => void this.inspectArtifact(task, undefined, this.artifact?.next)}>${t("tasksPage.supervision.more")}</button>` : nothing}
                      ${
                        this.fileBytes
                          ? html`<p>${this.fileName}</p>
                              <pre>
${new TextDecoder().decode(this.fileBytes.subarray(0, 65536))}</pre>
                              <p>${t("tasksPage.supervision.previewLimit")}</p>
                              <button
                                class="btn"
                                ?disabled=${disabled}
                                @click=${() => {
                                  if (this.fileBytes) {
                                    downloadBytesFile(
                                      this.fileName.split("/").at(-1) ?? "artifact",
                                      this.fileBytes,
                                    );
                                  }
                                }}
                              >
                                ${t("tasksPage.supervision.download")}
                              </button>`
                          : nothing
                      }
                    `
                  : nothing
              }
              <p>${t("tasksPage.supervision.artifact")} <code>${task.artifact.sourceHash}</code></p>
              ${
                canWrite
                  ? task.operatorCriteria.map(
                      (rule) =>
                        html`<p>
                          ${rule.criterionId}:
                          ${
                            rule.accepted
                              ? t("tasksPage.supervision.approved")
                              : html` <button
                                  class="btn"
                                  ?disabled=${disabled || this.artifact?.sourceHash !== task.artifact?.sourceHash}
                                  @click=${() => void this.control(task, { kind: "approve", sourceHash: task.artifact!.sourceHash, criterionIds: [rule.criterionId] })}
                                >
                                  ${t("tasksPage.supervision.approve")}
                                </button>`
                          }
                        </p>`,
                    )
                  : nothing
              }`
          : nothing
      }
    `;
  }
  render(canWrite: boolean) {
    const context = this.context();
    const sessions = (context.sessions.state.result?.sessions ?? []).filter((row) => {
      const agent = parseAgentSessionKey(row.key)?.agentId;
      return (
        agent &&
        (!context.agentSelection.state.scopeId || agent === context.agentSelection.state.scopeId)
      );
    });
    const chosen = this.selected;
    return renderSettingsSection(
      {
        title: t("tasksPage.supervision.title"),
        description: t("tasksPage.supervision.description"),
      },
      html`
        ${renderSettingsRow({
          title: t("tasksPage.supervision.session"),
          control: html` <select
              aria-label=${t("tasksPage.supervision.session")}
              .value=${this.sessionKey}
              ?disabled=${!this.gateway.connected}
              @change=${(event: Event) => {
                this.reset();
                this.sessionKey = (event.target as HTMLSelectElement).value;
                void this.refresh();
                this.host.requestUpdate();
              }}
            >
              <option value="">${t("tasksPage.supervision.chooseSession")}</option>
              ${sessions.map((session) => html`<option value=${session.key}>${session.displayName ?? session.derivedTitle ?? session.key}</option>`)}</select
            ><button
              class="btn"
              ?disabled=${this.busy || !this.gateway.connected || !this.sessionKey}
              @click=${() => void this.refresh()}
            >
              ${t("common.refresh")}
            </button>`,
        })}
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        ${this.tasks.map((task) =>
          renderSettingsRow({
            title: task.title,
            description: html`${t(`tasksPage.supervision.phase.${task.phase}`)} ·
            ${t(`tasksPage.supervision.custody.${!this.gateway.connected || (task.continuation === "armed" && (task.supervisorExpiresAt ?? 0) <= Date.now()) ? "unknown" : task.continuation}`)}`,
            control: html`<button
              class="btn"
              @click=${() => {
                this.selected = task;
                this.input = "";
                this.artifact = null;
                this.fileBytes = null;
                this.host.requestUpdate();
              }}
            >
              ${t("tasksPage.supervision.details")}
            </button>`,
          }),
        )}
        ${this.next ? html`<button class="btn" ?disabled=${this.busy} @click=${() => void this.refresh(this.next)}>${t("tasksPage.supervision.more")}</button>` : nothing}
        ${
          chosen
            ? renderSettingsRow({
                title: chosen.title,
                stacked: true,
                control: html`
                  <div class="tasks-supervision-details">
                    <p>
                      <code>${chosen.flowId}</code> ·
                      ${t("tasksPage.supervision.episode", { count: String(chosen.episode) })}
                    </p>
                    ${
                      chosen.endpoint
                        ? html`<p>${chosen.endpoint.reason}</p>
                            <p>${chosen.endpoint.question ?? ""}</p>`
                        : nothing
                    }
                    ${chosen.operations.map((operation) => html`<p>${operation.kind}: ${operation.state}</p>`)}
                    ${chosen.notifications.map((notification) => html`<p>${t("tasksPage.supervision.notification")}: ${t(`tasksPage.supervision.delivery.${notification.state}`)}</p>`)}
                    ${this.controls(chosen, canWrite)}
                  </div>
                `,
              })
            : nothing
        }
      `,
    );
  }
}
