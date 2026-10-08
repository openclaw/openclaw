import {
  createGitHubCiDetailsRenderer,
  GITHUB_CHECK_ORDER,
} from "@openclaw/github/control-ui-api.js";
import { svg, type PropertyValues } from "lit";
import { property, state as reactiveState } from "lit/decorators.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestCheckDetails,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

registerChatCiEnglish();

const REFRESH_MS = 30_000;
const SKIPPED_ICON = strokeIcon(svg`<circle cx="12" cy="12" r="10" /><path d="M8 12h8" />`);
const renderCiDetails = createGitHubCiDetailsRenderer({
  t,
  icons,
  skippedIcon: SKIPPED_ICON,
  formatDurationCompact,
  resolveSafeExternalUrl,
});

/** Presentation-only details: the Gateway owns GitHub discovery, joins, and caching. */
export class ChatCiDetailsElement extends OpenClawLightDomElement {
  @property({ attribute: false }) pullRequest?: ControlUiSessionPullRequest;
  @property({ attribute: false }) gateway?: ApplicationGateway;
  @property({ attribute: false }) sessionKey = "";
  @property({ type: Boolean }) presented = true;
  @reactiveState() private loading = false;
  @reactiveState() private result?: ControlUiSessionPullRequestCheckDetails;
  @reactiveState() private error: string | null = null;

  private disclosure: HTMLDetailsElement | null = null;
  private stopGateway?: () => void;
  private boundGateway?: ApplicationGateway;
  private readonly connection = createGatewayConnectionLifecycle({
    client: null,
    phase: "stopped",
  });
  private target = "";
  private requestGeneration = 0;
  private requestController?: AbortController;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private retryAt = 0;
  private readonly expandedJobs = new Map<number, boolean>();
  private expansionInitialized = false;

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
    this.stopGateway = undefined;
    this.boundGateway = undefined;
    this.connection.transition({ client: null, phase: "stopped" });
    this.reset();
    super.disconnectedCallback();
  }

  private targetKey(): string {
    const pr = this.pullRequest;
    return JSON.stringify([this.sessionKey, pr?.owner, pr?.repo, pr?.number, pr?.headSha]);
  }

  private get visible(): boolean {
    return (
      this.isConnected &&
      this.presented &&
      this.disclosure?.open === true &&
      this.ownerDocument.visibilityState !== "hidden"
    );
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const target = this.targetKey();
    if (target !== this.target) {
      // Head changes refresh the same open monitor; session changes dismiss it.
      if (changed.has("sessionKey") && changed.get("sessionKey") && this.disclosure) {
        this.disclosure.open = false;
      }
      this.target = target;
      this.reset();
    }
    if (this.boundGateway !== this.gateway) {
      this.stopGateway?.();
      this.boundGateway = this.gateway;
      this.connection.transition(this.gateway?.snapshot ?? { client: null, phase: "stopped" });
      this.reset();
      this.stopGateway = this.gateway?.subscribe((snapshot) => {
        if (this.connection.transition(snapshot)) {
          this.reset();
          void this.load();
        }
      });
    }
    if (!this.visible) {
      this.cancelRequest();
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (
      changed.has("pullRequest") ||
      changed.has("gateway") ||
      changed.has("sessionKey") ||
      changed.has("presented")
    ) {
      if (
        this.visible &&
        !this.loading &&
        (changed.has("presented") || (!this.result && !this.error))
      ) {
        void this.load();
      }
    }
  }

  private cancelRequest(): void {
    this.requestGeneration += 1;
    this.requestController?.abort();
    this.requestController = undefined;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.loading = false;
  }

  private reset(): void {
    this.cancelRequest();
    this.result = undefined;
    this.error = null;
    this.retryAt = 0;
    this.expandedJobs.clear();
    this.expansionInitialized = false;
  }

  private readonly handleToggle = (event: Event): void => {
    if (event.target !== this.disclosure) {
      return;
    }
    this.handleVisibility();
  };

  private readonly handleVisibility = (): void => {
    if (this.visible) {
      void this.load();
    } else {
      this.cancelRequest();
    }
  };

  private async load(): Promise<void> {
    if (!this.visible || this.loading) {
      return;
    }
    if (Date.now() < this.retryAt) {
      this.scheduleRetryAvailability();
      return;
    }
    const pr = this.pullRequest;
    const gateway = this.gateway;
    const scope = this.connection.capture();
    if (!scope || !gateway || !pr?.headSha || !this.sessionKey) {
      this.error = t("chat.pullRequests.checksUnavailable");
      return;
    }
    clearTimeout(this.refreshTimer);
    const generation = ++this.requestGeneration;
    const target = this.targetKey();
    const connectionGeneration = scope.client.connectionGeneration;
    const connectionRevision = gateway.connectionRevision;
    const controller = new AbortController();
    this.requestController = controller;
    this.loading = true;
    this.error = null;
    const current = () =>
      this.visible &&
      generation === this.requestGeneration &&
      target === this.targetKey() &&
      gateway === this.gateway &&
      gateway.connectionRevision === connectionRevision &&
      gateway.snapshot.client === scope.client &&
      gateway.snapshot.phase === "connected" &&
      this.connection.isCurrent(scope) &&
      scope.client.connectionGeneration === connectionGeneration;
    try {
      const result = await scope.client.request<ControlUiSessionPullRequestCheckDetails>(
        "controlUi.sessionPullRequests.checks",
        {
          sessionKey: this.sessionKey,
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha,
        },
        { signal: controller.signal },
      );
      if (!current()) {
        return;
      }
      if (
        result.owner.toLowerCase() !== pr.owner.toLowerCase() ||
        result.repo.toLowerCase() !== pr.repo.toLowerCase() ||
        result.number !== pr.number ||
        result.headSha !== pr.headSha
      ) {
        this.result = undefined;
        this.error = t("chat.pullRequests.checksUnavailable");
        return;
      }
      this.result = result;
      this.retryAt =
        Date.now() + Math.max(0, result.retryAfterMs ?? (result.rateLimited ? 60_000 : 0));
      if (!this.expansionInitialized && result.checks.length > 0) {
        this.expansionInitialized = true;
        const first = result.checks
          .toSorted((a, b) => GITHUB_CHECK_ORDER[a.state] - GITHUB_CHECK_ORDER[b.state])
          .find((check) => check.state === "failed" || check.state === "running");
        if (first) {
          this.expandedJobs.set(first.id, true);
        }
      }
      const ids = new Set(result.checks.map((check) => check.id));
      for (const id of this.expandedJobs.keys()) {
        if (!ids.has(id)) {
          this.expandedJobs.delete(id);
        }
      }
      if (this.retryAt > Date.now()) {
        this.scheduleRetryAvailability();
      } else if (result.status === "ready") {
        // Completed jobs can be rerun on the same head without changing the
        // summary counts. Poll only the visible monitor, even after completion.
        this.refreshTimer = setTimeout(() => void this.load(), REFRESH_MS);
      }
    } catch (error) {
      if (current()) {
        // Only explicit stale responses authorize retaining previous details.
        this.result = undefined;
        this.error = formatUiError(error, t("chat.pullRequests.checksUnavailable"));
      }
    } finally {
      if (current()) {
        this.loading = false;
        this.requestController = undefined;
      }
    }
  }

  private scheduleRetryAvailability(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => this.requestUpdate(),
      Math.min(2_147_483_647, Math.max(0, this.retryAt - Date.now())),
    );
  }

  override render() {
    return renderCiDetails({
      loading: this.loading,
      result: this.result,
      error: this.error,
      retryAt: this.retryAt,
      expandedJobs: this.expandedJobs,
      baseURI: this.ownerDocument.baseURI,
      onRetry: () => void this.load(),
      onExpandedChange: (id, expanded) => {
        this.expandedJobs.set(id, expanded);
        this.requestUpdate();
      },
    });
  }
}

if (!customElements.get("openclaw-chat-ci-details")) {
  customElements.define("openclaw-chat-ci-details", ChatCiDetailsElement);
}
