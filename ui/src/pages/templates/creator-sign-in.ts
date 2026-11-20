import type {
  TemplatesDraftsSignInParams,
  TemplatesDraftsSignInResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { TemplateReviewTarget, TemplateSignInPresentation } from "./creator-publication.ts";

const METHOD = "templates.drafts.signIn";

type Pending = Extract<TemplatesDraftsSignInResult, { status: "pending" }>;

type Target = TemplateReviewTarget & { client: GatewayBrowserClient };

export class TemplateCreatorSignIn {
  state: TemplateSignInPresentation | null = null;
  checking = false;
  private checked = false;
  private presented = false;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly changed: () => void,
    private readonly connected: () => void,
  ) {}

  private request(
    target: Target,
    action: TemplatesDraftsSignInParams["action"],
    requestId?: string,
  ) {
    return target.client.request<TemplatesDraftsSignInResult>(METHOD, {
      agentId: target.agentId,
      draftId: target.draftId,
      sourceSessionKey: target.sessionKey,
      action,
      ...(requestId ? { requestId } : {}),
    });
  }

  retire() {
    this.presented = false;
    clearTimeout(this.timer);
  }

  reset() {
    this.retire();
    this.version++;
    this.checked = false;
    this.checking = false;
    this.state = null;
  }

  show(target: Target) {
    this.presented = true;
    if (this.state?.status === "pending") {
      this.schedule(target, this.state);
    }
    if (this.checked) {
      return;
    }
    this.checked = true;
    this.checking = true;
    const version = this.version;
    void this.request(target, "status").then(
      (result) => {
        if (version !== this.version) {
          return;
        }
        this.checking = false;
        if (result.status === "required") {
          this.require();
        } else {
          this.state = null;
          this.connected();
        }
      },
      () => {
        if (version === this.version) {
          this.checking = false;
          // Normal review owns other failures, e.g. a missing publisher handle.
          this.connected();
        }
      },
    );
  }

  require() {
    this.state ??= { status: "required" };
    this.changed();
  }

  async start(target: Target) {
    if (!this.state || this.state.status === "starting" || this.state.status === "pending") {
      return;
    }
    const version = ++this.version;
    this.state = { status: "starting" };
    this.changed();
    try {
      const result = await this.request(target, "start");
      if (version !== this.version) {
        return;
      }
      if (result.status !== "pending") {
        this.apply(target, result);
        return;
      }
      const url = URL.parse(result.verificationUrl);
      if (!url || !["https:", "http:"].includes(url.protocol)) {
        throw new Error("Invalid ClawHub approval URL");
      }
      this.apply(target, { ...result, verificationUrl: url.href });
    } catch {
      if (version === this.version) {
        this.apply(target, { status: "failed" });
      }
    }
  }

  async cancel(target: Target) {
    if (this.state?.status !== "pending") {
      return;
    }
    const pending = this.state;
    const version = ++this.version;
    clearTimeout(this.timer);
    try {
      const result = await this.request(target, "cancel", pending.requestId);
      if (version === this.version) {
        this.apply(target, result);
      }
    } catch {
      // Cancellation is not confirmed. Observe the original request, not a new one.
      if (version === this.version) {
        this.schedule(target, pending);
      }
    }
  }

  private apply(target: Target, result: TemplatesDraftsSignInResult) {
    if (result.status === "connected") {
      this.state = null;
      this.connected();
      return;
    }
    if (result.status === "finishing" && this.state?.status === "pending") {
      this.schedule(target, this.state);
      return;
    }
    if (result.status === "pending") {
      this.schedule(target, result);
      // Keep the verified URL obtained by start for this request.
      this.state = {
        ...result,
        verificationUrl:
          this.state?.status === "pending" ? this.state.verificationUrl : result.verificationUrl,
      };
    } else {
      this.state = { status: result.status === "finishing" ? "failed" : result.status };
    }
    this.changed();
  }

  private schedule(target: Target, pending: Pending) {
    clearTimeout(this.timer);
    if (!this.presented) {
      return;
    }
    const version = this.version;
    this.timer = setTimeout(() => {
      void this.poll(target, pending, version);
    }, pending.pollAfterMs);
  }

  private async poll(target: Target, pending: Pending, version: number) {
    try {
      const result = await this.request(target, "poll", pending.requestId);
      if (version === this.version) {
        this.apply(target, result);
      }
    } catch {
      if (version === this.version) {
        // A lost reply may follow a committed connection. Keep observing the same request.
        if (Date.now() <= pending.expiresAt + 10_000) {
          this.schedule(target, {
            ...pending,
            pollAfterMs: Math.max(2_500, pending.pollAfterMs),
          });
        } else {
          this.apply(target, { status: "failed" });
        }
      }
    }
  }
}
