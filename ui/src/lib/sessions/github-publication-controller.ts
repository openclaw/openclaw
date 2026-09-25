import { readGitHubPublicationSelectionRejectedError } from "@openclaw/gateway-protocol/gateway-error-details";
import type { Static } from "typebox";
import type {
  GitHubPublicationPublisher,
  GitHubPublicationSelection,
  SessionGitHubOptionsParamsSchema,
  SessionGitHubOptionsResultSchema,
  SessionGitHubPublicationResult,
  SessionGitHubStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../format-error.ts";
import { generateUUID } from "../uuid.ts";

export type GitHubPublicationOptions = Static<typeof SessionGitHubOptionsResultSchema>;
type GitHubPublicationPresentation = {
  canWrite: boolean;
  personalReady: boolean;
  isPresented: () => boolean;
  isCurrent: () => boolean;
};
type PublicationOwner = {
  client: Pick<GatewayBrowserClient, "request">;
  target: Pick<Static<typeof SessionGitHubOptionsParamsSchema>, "sessionKey" | "agentId">;
  isCurrent: () => boolean;
  reserve: () => void;
  release: () => void;
  unbound: () => void;
};
type Presentation = {
  scope: GitHubPublicationPresentation | null;
  changed: (() => void) | null;
};
export type GitHubPublicationPresentationBinding = {
  sync: (scope: GitHubPublicationPresentation) => void;
  view: () => GitHubPublicationView | undefined;
  reset: () => void;
  detach: () => void;
  readonly result: SessionGitHubPublicationResult | null;
};
type GitHubPublicationActivity = "read" | "publish" | "confirm";

export type GitHubPublicationView = {
  activity: GitHubPublicationActivity | null;
  canWrite: boolean;
  locked: boolean;
  options: GitHubPublicationOptions | null;
  selection: GitHubPublicationSelection | null;
  result: SessionGitHubPublicationResult | null;
  confirmation: SessionGitHubStatusResult["confirmation"];
  error: string | null;
  personalReady: boolean;
  onSelect?: (source: "shared" | "personal") => void;
  onPublish?: () => void;
  onConfirm?: () => void;
  onRefresh: () => void;
  onNewAction?: () => void;
};

function terminal(result: SessionGitHubPublicationResult | null): boolean {
  return result?.status === "published" || result?.status === "failed";
}

export function selectedGitHubPublisher(
  selection: GitHubPublicationSelection | null,
): GitHubPublicationPublisher | undefined {
  return selection?.source === "personal"
    ? { source: "personal", ...selection.account }
    : selection?.expected;
}

/** Owns one session's explicit publication; connection/access changes retire every response. */
export class GitHubPublicationController {
  private readonly presentations = new Set<Presentation>();
  private version = 0;
  private activity: GitHubPublicationActivity | null = null;
  private options: GitHubPublicationOptions | null = null;
  private selection: GitHubPublicationSelection | null = null;
  private attempt: { idempotencyKey: string; selection: GitHubPublicationSelection } | null = null;
  result: SessionGitHubPublicationResult | null = null;
  private confirmation: SessionGitHubStatusResult["confirmation"] = null;
  private error: string | null = null;
  private reviewedRequestId: string | null = null;
  private refreshPending = false;

  constructor(private readonly owner: PublicationOwner) {}

  private get busy(): boolean {
    return this.activity !== null;
  }

  get hasBindings(): boolean {
    return this.presentations.size > 0;
  }

  reset(): void {
    this.owner.release();
    this.version += 1;
    this.activity = null;
    this.options = null;
    this.selection = null;
    this.attempt = null;
    this.result = null;
    this.confirmation = null;
    this.error = null;
    this.reviewedRequestId = null;
    this.refreshPending = false;
  }

  private resetPresentation(): void {
    const reviewed = terminal(this.result) ? this.result!.requestId : this.reviewedRequestId;
    this.reset();
    this.reviewedRequestId = reviewed;
  }

  invalidate(): void {
    if (
      this.attempt?.selection.source === "personal" ||
      this.result?.publisher?.source === "personal" ||
      (!this.locked && this.selection?.source === "personal")
    ) {
      return;
    }
    this.refreshPending = true;
    this.flushRefresh();
  }

  private flushRefresh(): void {
    if (!this.refreshPending || this.busy || !this.owner.isCurrent()) {
      return;
    }
    const presented = [...this.presentations].find((candidate) => this.presented(candidate));
    // A retained request may settle while its pane is absent; idle hidden panes wait.
    if (presented || this.locked) {
      void this.refresh(presented ?? null);
    }
  }

  private changed(): void {
    for (const presentation of this.presentations) {
      presentation.changed?.();
    }
  }

  private presented(presentation: Presentation): boolean {
    return (
      this.presentations.has(presentation) &&
      this.owner.isCurrent() &&
      presentation.scope?.isCurrent() === true &&
      presentation.scope.isPresented()
    );
  }

  private retireIdleOptions(): void {
    if (
      !this.busy &&
      !this.locked &&
      !this.result &&
      !this.error &&
      ![...this.presentations].some((presentation) => this.presented(presentation))
    ) {
      this.resetPresentation();
    }
  }

  bind(changed: () => void): GitHubPublicationPresentationBinding {
    const presentation: Presentation = { scope: null, changed };
    this.presentations.add(presentation);
    const getResult = () => this.result;
    return {
      sync: (scope) => {
        if (!this.presentations.has(presentation)) {
          return;
        }
        presentation.scope = scope;
        this.retireIdleOptions();
        if (
          this.presented(presentation) &&
          !this.busy &&
          !this.options &&
          !this.result &&
          !this.error
        ) {
          void this.refresh(presentation);
        }
        this.flushRefresh();
      },
      view: () => this.view(presentation),
      get result() {
        return getResult();
      },
      reset: () => {
        if (this.presented(presentation)) {
          this.resetPresentation();
          this.changed();
        }
      },
      detach: () => {
        presentation.scope = null;
        presentation.changed = null;
        this.presentations.delete(presentation);
        this.retireIdleOptions();
        if (!this.hasBindings) {
          this.owner.unbound();
        }
      },
    };
  }

  private get locked(): boolean {
    return this.attempt !== null || (this.result !== null && !terminal(this.result));
  }

  private choose(presentation: Presentation, source: "shared" | "personal"): void {
    const options = this.options;
    if (
      !options ||
      this.locked ||
      this.busy ||
      !this.presented(presentation) ||
      !presentation.scope?.canWrite
    ) {
      return;
    }
    const personal = options.personal;
    this.selection =
      source === "shared"
        ? options.shared
          ? { source, expected: options.shared }
          : null
        : personal?.state === "connected" && personal.account && personal.generation
          ? { source, account: personal.account, generation: personal.generation }
          : null;
    this.version += 1;
    this.changed();
  }

  private async run(
    presentation: Presentation | null,
    activity: GitHubPublicationActivity,
    action: (scope: PublicationOwner, current: () => boolean) => Promise<void>,
  ): Promise<void> {
    const admitted = presentation
      ? this.presented(presentation)
      : activity === "read" && this.owner.isCurrent() && this.locked;
    if (!admitted || this.busy) {
      return;
    }
    const version = ++this.version;
    const current = () => this.version === version && this.owner.isCurrent();
    this.activity = activity;
    this.error = null;
    this.changed();
    try {
      await action(this.owner, current);
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.version === version) {
        if (current()) {
          this.activity = null;
        } else {
          this.reset();
        }
        this.changed();
        this.flushRefresh();
      }
    }
  }

  private applyResult(result: SessionGitHubPublicationResult): void {
    this.result = result;
    this.confirmation = null;
    if (terminal(result)) {
      this.attempt = null;
      if (
        result.publisher &&
        result.publisher.source !== "personal" &&
        ![...this.presentations].some((presentation) => this.presented(presentation))
      ) {
        this.owner.release();
      }
    }
  }

  private async readStatus(
    scope: PublicationOwner,
    current: () => boolean,
    requestId: string,
  ): Promise<void> {
    const status = await scope.client.request<SessionGitHubStatusResult>("sessions.github.status", {
      ...scope.target,
      requestId,
    });
    if (current()) {
      this.applyResult(status.result);
      this.confirmation = status.confirmation;
    }
  }

  private async refresh(presentation: Presentation | null): Promise<void> {
    await this.run(presentation, "read", async (scope, current) => {
      this.refreshPending = false;
      if (this.result && !terminal(this.result)) {
        await this.readStatus(scope, current, this.result.requestId);
        return;
      }
      const sharedAttempt = this.attempt?.selection.source === "shared" ? this.attempt : null;
      const options = await scope.client.request<GitHubPublicationOptions>(
        "sessions.github.options",
        {
          ...scope.target,
          ...(sharedAttempt ? { idempotencyKey: sharedAttempt.idempotencyKey } : {}),
        },
      );
      if (!current()) {
        return;
      }
      this.options = options;
      let recovered = !this.locked && !this.result ? options.pendingPersonal : null;
      if (
        !recovered &&
        (sharedAttempt ||
          (!this.locked &&
            this.selection?.source !== "personal" &&
            (!this.result ||
              (terminal(this.result) && this.result.publisher?.source !== "personal"))))
      ) {
        recovered = options.latestShared;
      }
      if (recovered && recovered.result.requestId !== this.reviewedRequestId) {
        const publisher = recovered.result.publisher;
        if (recovered === options.pendingPersonal || !terminal(recovered.result)) {
          this.owner.reserve();
        }
        this.applyResult(recovered.result);
        this.confirmation = recovered.confirmation;
        if (!this.attempt && publisher && publisher.source !== "personal") {
          this.selection = {
            source: "shared",
            expected: {
              source: publisher.source,
              accountId: publisher.accountId,
              login: publisher.login,
            },
          };
        }
      }
      // Connecting My GitHub never changes the shared default. An in-flight
      // attempt retains the exact account/generation even if fresh options differ.
      if (!this.locked && !this.selection && options.shared) {
        this.selection = { source: "shared", expected: options.shared };
      }
    });
  }
  private async publish(presentation: Presentation): Promise<void> {
    const selection = this.attempt?.selection ?? this.selection;
    if (
      !presentation.scope?.canWrite ||
      !selection ||
      terminal(this.result) ||
      (selection.source === "personal" && !presentation.scope.personalReady) ||
      (this.locked && !this.attempt)
    ) {
      return;
    }
    await this.run(presentation, "publish", async (owner, current) => {
      this.owner.reserve();
      const firstInvocation = this.attempt === null;
      const attempt = this.attempt ?? { idempotencyKey: generateUUID(), selection };
      this.attempt = attempt;
      const result = await owner.client
        .request<SessionGitHubPublicationResult>("sessions.github.publish", {
          ...owner.target,
          ...attempt,
        })
        .catch((error: unknown) => {
          // A rejected retry says nothing about an earlier same-key call still preparing.
          if (
            firstInvocation &&
            current() &&
            this.attempt === attempt &&
            readGitHubPublicationSelectionRejectedError(error)?.idempotencyKey ===
              attempt.idempotencyKey
          ) {
            this.owner.release();
            this.attempt = null;
            this.selection = null;
            this.options = null;
          }
          throw error;
        });
      if (!current()) {
        return;
      }
      this.applyResult(result);
      if (result.status === "needs_confirmation") {
        await this.readStatus(owner, current, result.requestId);
      }
    });
  }

  private async confirm(presentation: Presentation): Promise<void> {
    const confirmation = this.confirmation;
    const requestId = this.result?.requestId;
    if (
      !confirmation ||
      !requestId ||
      !presentation.scope?.canWrite ||
      !presentation.scope.personalReady
    ) {
      return;
    }
    await this.run(presentation, "confirm", async (scope, current) => {
      const result = await scope.client.request<SessionGitHubPublicationResult>(
        "sessions.github.confirm",
        {
          ...scope.target,
          requestId,
          generation: confirmation.generation,
          account: confirmation.account,
          requestDigest: confirmation.requestDigest,
        },
      );
      if (current()) {
        this.applyResult(result);
        if (result.status === "needs_confirmation") {
          await this.readStatus(scope, current, requestId);
        }
      }
    });
  }

  private view(presentation: Presentation): GitHubPublicationView | undefined {
    const scope = presentation.scope;
    if (!scope || !this.presented(presentation)) {
      return undefined;
    }
    const version = this.version;
    // Each callback belongs to the displayed operation state, not whichever
    // publication or confirmation happens to occupy this session later.
    const invoke = (action: () => void) => {
      if (version === this.version && this.presented(presentation)) {
        action();
      }
    };
    return {
      activity: this.activity,
      canWrite: scope.canWrite,
      locked: this.locked,
      options: this.options,
      selection: this.attempt?.selection ?? this.selection,
      result: this.result,
      confirmation: this.confirmation,
      error: this.error,
      personalReady: scope.personalReady,
      onSelect:
        scope.canWrite && !this.result && !this.locked
          ? (source) => invoke(() => this.choose(presentation, source))
          : undefined,
      onPublish:
        scope.canWrite && (!this.locked || this.attempt !== null) && !terminal(this.result)
          ? () => invoke(() => void this.publish(presentation))
          : undefined,
      onConfirm:
        scope.canWrite && this.confirmation
          ? () => invoke(() => void this.confirm(presentation))
          : undefined,
      onRefresh: () => invoke(() => void this.refresh(presentation)),
      // Acknowledgement releases local custody; publication and confirmation remain write-gated.
      onNewAction: terminal(this.result)
        ? () =>
            invoke(() => {
              if (this.busy) {
                return;
              }
              this.resetPresentation();
              void this.refresh(presentation);
            })
        : undefined,
    };
  }
}
