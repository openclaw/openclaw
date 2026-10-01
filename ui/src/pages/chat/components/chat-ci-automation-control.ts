import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import type { PropertyValues } from "lit";
import { property, state as reactiveState } from "lit/decorators.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { CronStatus } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import type {
  CiAutomationOption,
  CiAutomationTarget,
} from "../../../lib/session-pr-automation-spec.ts";
import {
  loadCiAutomationJobs,
  setCiAutomationEnabled,
  type CiAutomationJobs,
} from "../../../lib/session-pr-automation.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { renderChatCiAutomation } from "./chat-ci-automation.ts";

/** Cron owns durable settings and execution; this element retains only the visible projection. */
export class ChatCiAutomationElement extends OpenClawLightDomElement {
  @property({ attribute: false }) gateway?: ApplicationGateway;
  @property({ attribute: false }) pullRequest?: ControlUiSessionPullRequest;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) sessionId = "";
  @property({ attribute: false }) basePath = "";
  @property({ type: Boolean }) presented = true;
  @reactiveState() private jobs: CiAutomationJobs = {};
  @reactiveState() private loading = false;
  @reactiveState() private saving = false;
  @reactiveState() private loaded = false;
  @reactiveState() private schedulerEnabled: boolean | undefined;
  @reactiveState() private error: string | null = null;

  private disclosure: HTMLDetailsElement | null = null;
  private boundGateway?: ApplicationGateway;
  private stopGateway?: () => void;
  private stopEvents?: () => void;
  private readonly connection = createGatewayConnectionLifecycle({
    client: null,
    phase: "stopped",
  });
  private connectionRevision = -1;
  private connectionGeneration = -1;
  private authKey = "";
  private targetKey = "";
  private version = 0;
  private readGeneration = 0;
  private readController?: AbortController;
  private refreshPending = true;

  override connectedCallback(): void {
    super.connectedCallback();
    this.disclosure = this.closest<HTMLDetailsElement>(".chat-pr__checks");
    this.disclosure?.addEventListener("toggle", this.handleToggle);
    this.ownerDocument.addEventListener("visibilitychange", this.handleVisibility);
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.disclosure?.removeEventListener("toggle", this.handleToggle);
    this.ownerDocument.removeEventListener("visibilitychange", this.handleVisibility);
    this.stopGateway?.();
    this.stopEvents?.();
    this.stopGateway = undefined;
    this.stopEvents = undefined;
    this.boundGateway = undefined;
    this.connection.transition({ client: null, phase: "stopped" });
    this.reset();
    super.disconnectedCallback();
  }

  private get visible(): boolean {
    return (
      this.isConnected &&
      this.presented &&
      this.disclosure?.open === true &&
      this.ownerDocument.visibilityState !== "hidden"
    );
  }

  private automationTarget(): CiAutomationTarget | null {
    const pr = this.pullRequest;
    const agentId = parseAgentSessionKeyParts(this.sessionKey)?.agentId;
    if (!pr || !agentId || !this.sessionId.trim()) {
      return null;
    }
    return {
      sessionKey: this.sessionKey,
      sessionId: this.sessionId,
      agentId,
      owner: pr.owner.toLowerCase(),
      repo: pr.repo.toLowerCase(),
      number: pr.number,
    };
  }

  private currentTargetKey(): string {
    // A pushed commit changes the CI monitor, not the PR's durable automation identity.
    return JSON.stringify([this.sessionKey, this.sessionId, this.automationTarget()]);
  }

  private canRead(): boolean {
    return ["cron.list", "cron.status"].every((method) =>
      canCallGatewayMethod(this.gateway?.snapshot, method, "operator.read", {
        requireAdvertisement: false,
      }),
    );
  }

  private canManage(): boolean {
    return ["cron.add", "cron.update"].every((method) =>
      canCallGatewayMethod(this.gateway?.snapshot, method, "operator.admin", {
        requireAdvertisement: false,
      }),
    );
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const target = this.currentTargetKey();
    if (target !== this.targetKey) {
      if ((changed.get("sessionKey") || changed.get("sessionId")) && this.disclosure) {
        this.disclosure.open = false;
      }
      this.targetKey = target;
      this.reset();
    }
    if (this.boundGateway !== this.gateway) {
      this.stopGateway?.();
      this.stopEvents?.();
      this.boundGateway = this.gateway;
      this.reset();
      const gateway = this.gateway;
      this.stopGateway = gateway?.subscribe(() => {
        if (this.gateway === gateway && this.boundGateway === gateway) {
          this.syncConnection();
          this.requestUpdate();
        }
      });
      this.stopEvents = gateway?.subscribeEvents((event) => {
        if (
          this.gateway === gateway &&
          this.boundGateway === gateway &&
          (event.event === "cron" || event.event === "config.changed")
        ) {
          this.invalidate();
        }
      });
    }
    this.syncConnection();
    if (changed.has("presented")) {
      this.refreshPending = true;
    }
    if (!this.visible) {
      this.cancelRead();
    }
  }

  protected override updated(): void {
    if (this.refreshPending && this.visible && !this.loading && !this.saving) {
      void this.load();
    }
  }

  private syncConnection(): void {
    const gateway = this.gateway;
    const snapshot = gateway?.snapshot ?? { client: null, phase: "stopped" as const };
    const transitioned = this.connection.transition(snapshot);
    const revision = gateway?.connectionRevision ?? -1;
    const generation = snapshot.client?.connectionGeneration ?? -1;
    const auth = JSON.stringify(gateway?.snapshot.hello?.auth ?? null);
    if (
      transitioned ||
      revision !== this.connectionRevision ||
      generation !== this.connectionGeneration ||
      auth !== this.authKey
    ) {
      this.connectionRevision = revision;
      this.connectionGeneration = generation;
      this.authKey = auth;
      this.connection.invalidate();
      this.reset();
    }
  }

  private cancelRead(): void {
    if (!this.readController) {
      return;
    }
    this.readGeneration += 1;
    this.readController.abort();
    this.readController = undefined;
    this.loading = false;
    this.refreshPending = true;
  }

  private reset(): void {
    this.version += 1;
    this.cancelRead();
    this.jobs = {};
    this.loaded = false;
    this.saving = false;
    this.schedulerEnabled = undefined;
    this.error = null;
    this.refreshPending = true;
  }

  private invalidate(): void {
    // One trailing authoritative read absorbs event bursts and in-flight writes.
    this.refreshPending = true;
    this.requestUpdate();
  }

  private readonly handleToggle = (event: Event): void => {
    if (event.target === this.disclosure) {
      this.handleVisibility();
    }
  };

  private readonly handleVisibility = (): void => {
    if (!this.visible) {
      this.cancelRead();
    }
    this.invalidate();
  };

  private capture() {
    const gateway = this.gateway;
    const scope = this.connection.capture();
    const target = this.automationTarget();
    if (!gateway || !scope || !target) {
      return null;
    }
    const version = this.version;
    const targetKey = this.currentTargetKey();
    const revision = gateway.connectionRevision;
    const generation = scope.client.connectionGeneration;
    const auth = JSON.stringify(gateway.snapshot.hello?.auth ?? null);
    return {
      client: scope.client,
      target,
      current: () =>
        this.isConnected &&
        version === this.version &&
        targetKey === this.currentTargetKey() &&
        targetKey === this.targetKey &&
        gateway === this.gateway &&
        gateway === this.boundGateway &&
        revision === this.connectionRevision &&
        generation === this.connectionGeneration &&
        auth === this.authKey &&
        gateway.connectionRevision === revision &&
        gateway.snapshot.client === scope.client &&
        gateway.snapshot.phase === "connected" &&
        this.connection.isCurrent(scope) &&
        scope.client.connectionGeneration === generation &&
        JSON.stringify(gateway.snapshot.hello?.auth ?? null) === auth,
    };
  }

  private async load(): Promise<void> {
    if (!this.visible || this.loading || this.saving) {
      return;
    }
    this.refreshPending = false;
    const owner = this.capture();
    if (!owner || !owner.current() || !this.canRead()) {
      this.requestUpdate();
      return;
    }
    const controller = new AbortController();
    const generation = ++this.readGeneration;
    this.readController = controller;
    this.loading = true;
    this.error = null;
    const current = () => owner.current() && this.visible && generation === this.readGeneration;
    try {
      const [jobs, status] = await Promise.all([
        loadCiAutomationJobs(owner.client, owner.target, controller.signal),
        owner.client.request<CronStatus>("cron.status", {}, { signal: controller.signal }),
      ]);
      if (current()) {
        this.jobs = jobs;
        this.schedulerEnabled = status.enabled;
        this.loaded = true;
      }
    } catch (error) {
      if (current()) {
        this.loaded = false;
        this.error = formatUiError(error, t("chat.pullRequests.automationLoadFailed"));
      }
    } finally {
      if (current()) {
        this.loading = false;
        this.readController = undefined;
        this.requestUpdate();
      }
    }
  }

  private async setEnabled(option: CiAutomationOption, enabled: boolean): Promise<void> {
    if (
      !this.visible ||
      !this.loaded ||
      this.loading ||
      this.saving ||
      this.refreshPending ||
      !this.canRead() ||
      !this.canManage()
    ) {
      return;
    }
    const owner = this.capture();
    if (!owner || !owner.current()) {
      return;
    }
    this.saving = true;
    this.error = null;
    try {
      const job = await setCiAutomationEnabled(
        owner.client,
        owner.target,
        option,
        enabled,
        this.jobs[option],
      );
      if (!owner.current()) {
        return;
      }
      if (this.visible) {
        this.jobs = { ...this.jobs, [option]: job };
      }
      this.refreshPending = true;
    } catch (error) {
      if (owner.current()) {
        // A rejected acknowledgement may hide an accepted write. Never mutate again
        // until a complete authoritative inventory has reconciled the actual outcome.
        this.loaded = false;
        this.error = formatUiError(error, t("chat.pullRequests.automationSaveFailed"));
      }
    } finally {
      if (owner.current()) {
        this.saving = false;
        this.requestUpdate();
      }
    }
  }

  override render() {
    const unavailable = !this.automationTarget()
      ? t("chat.pullRequests.automationSessionRequired")
      : !this.canRead()
        ? t("chat.pullRequests.automationReadRequired")
        : !this.canManage()
          ? t("chat.pullRequests.automationAdminRequired")
          : !this.loaded
            ? t("chat.pullRequests.automationRefreshRequired")
            : undefined;
    return renderChatCiAutomation({
      options: {
        autoFix: this.jobs.autoFix?.enabled === true,
        autoMerge: this.jobs.autoMerge?.enabled === true,
        autoArchive: this.jobs.autoArchive?.enabled === true,
      },
      jobs: this.jobs,
      basePath: this.basePath,
      schedulerEnabled: this.schedulerEnabled,
      loading: this.loading,
      saving: this.saving,
      error: this.error,
      disabled: Boolean(unavailable) || this.refreshPending,
      disabledReason: unavailable,
      retryDisabled: !this.automationTarget() || !this.canRead(),
      onChange: (option, enabled) => void this.setEnabled(option, enabled),
      onRetry: () => this.invalidate(),
    });
  }
}

if (!customElements.get("openclaw-chat-ci-automation")) {
  customElements.define("openclaw-chat-ci-automation", ChatCiAutomationElement);
}
