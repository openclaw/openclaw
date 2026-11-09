import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNativeExternalLink, postNativeExternalLink } from "../../app/native-link-routing.ts";
import { dispatchWidgetPrompt } from "../../components/mcp-app-security.ts";
import { openExternalUrlSafe } from "../open-external-url.ts";

type BoardWidgetBridgeRequest = {
  type: "openclaw:widget-bridge-request";
  id: string;
  method: string;
  params: unknown;
  ticket: string;
  /** Captured by the trusted inner wrapper over its private port, never request params. */
  userActivated?: boolean;
};

export type BoardWidgetBridgeGatewayClient = {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

const STATE_PAYLOAD_MAX_BYTES = 8 * 1024;
const STATE_COALESCE_WINDOW_MS = 5_000;
const STATE_RATE_WINDOW_MS = 60_000;
const STATE_RATE_MAX_ATTEMPTS = 12;

// Spends the page's transient activation the way an opened popup does. WebKit's
// consume-user-activation clears it in every frame, so the widget frame needs
// new input before the next open. A detached text input has no picker to show,
// and showPicker() throws when no activation is left to spend.
function consumeUserActivation(): boolean {
  try {
    document.createElement("input").showPicker();
  } catch {
    return false;
  }
  return !navigator.userActivation.isActive;
}

export function isBoardWidgetBridgeRequest(value: unknown): value is BoardWidgetBridgeRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Partial<BoardWidgetBridgeRequest>;
  return (
    request.type === "openclaw:widget-bridge-request" &&
    typeof request.id === "string" &&
    request.id.length > 0 &&
    request.id.length <= 128 &&
    typeof request.method === "string" &&
    typeof request.ticket === "string"
  );
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`widget host request ${key} is required`);
  }
  return value;
}

/** Transport admission, ticket identity, and in-flight coalescing stay synchronous. */
export class BoardWidgetBridgeOwner {
  private readonly recentStatePayloads = new Map<string, number>();
  private readonly pendingStates = new Map<string, Promise<unknown>>();
  private stateAttemptTimes: number[] = [];

  constructor(
    private readonly options: {
      frame: HTMLIFrameElement;
      ticket: string;
      client: BoardWidgetBridgeGatewayClient;
      rateKey: string;
      confirmPrompt: (text: string) => boolean | Promise<boolean>;
      /** Whether this widget's own sandbox frame holds live user activation. */
      widgetActivated: () => Promise<boolean>;
      actionBindingNames?: () => readonly string[];
    },
  ) {
    this.options = { ...options };
  }

  updateIdentity(frame: HTMLIFrameElement, ticket: string): void {
    this.options.frame = frame;
    this.options.ticket = ticket;
  }

  private async emitState(payload: unknown): Promise<unknown> {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      throw new Error("widget state payload must be JSON");
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > STATE_PAYLOAD_MAX_BYTES) {
      throw new Error(`widget state payload exceeds ${STATE_PAYLOAD_MAX_BYTES} UTF-8 bytes`);
    }
    const nowMs = Date.now();
    for (const [recentPayload, emittedAtMs] of this.recentStatePayloads) {
      if (nowMs - emittedAtMs >= STATE_COALESCE_WINDOW_MS) {
        this.recentStatePayloads.delete(recentPayload);
      }
    }
    if (this.recentStatePayloads.has(serialized)) {
      return { ok: true, appended: false, coalesced: true };
    }
    const pendingState = this.pendingStates.get(serialized);
    if (pendingState) {
      return await pendingState;
    }
    this.stateAttemptTimes = this.stateAttemptTimes.filter(
      (attemptAtMs) => nowMs - attemptAtMs < STATE_RATE_WINDOW_MS,
    );
    if (this.stateAttemptTimes.length >= STATE_RATE_MAX_ATTEMPTS) {
      throw new Error("widget state emission rate limit exceeded");
    }
    this.stateAttemptTimes.push(nowMs);
    const { client, ticket } = this.options;
    const request = client.request("board.event", { ticket, payload });
    this.pendingStates.set(serialized, request);
    try {
      const result = await request;
      this.recentStatePayloads.set(serialized, Date.now());
      return result;
    } finally {
      if (this.pendingStates.get(serialized) === request) {
        this.pendingStates.delete(serialized);
      }
    }
  }

  async handle(
    request: BoardWidgetBridgeRequest,
    options: { promptUserActivated?: boolean; isCurrent?: () => boolean } = {},
  ): Promise<unknown> {
    if (request.ticket !== this.options.ticket) {
      throw new Error("widget view ticket does not match the active frame");
    }
    const params = request.params;
    if (!isRecord(params)) {
      throw new Error("widget host request params are invalid");
    }
    switch (request.method) {
      // Opening a link the user clicked is navigation, not a granted capability,
      // so this stays outside the tool-grant checks. Native hosts take it through
      // their link owner, because WebKit's popup blocker scopes the click's
      // gesture to its own task and refuses window.open in this MessagePort task,
      // although transient user activation survives the hop. Browsers use the
      // Control UI's openExternalUrlSafe owner, which applies noopener/noreferrer
      // regardless of the `rel` a widget wrote. The absolute-http(s) gate here is
      // deliberately narrower than both: widget-supplied links must not reach
      // `blob:`, which the general external-link path allows.
      case "host.open": {
        const url = requiredString(params, "url");
        if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
          throw new Error("widget link url is invalid");
        }
        // Native refusal is terminal; only bridge absence selects the browser.
        if (hasNativeExternalLink()) {
          // Both the dashboard and this widget must hold live activation. The
          // widget-specific query excludes input elsewhere; consumption makes
          // each gesture single-use, even though native posting skips WebKit's
          // popup blocker.
          const activated =
            navigator.userActivation?.isActive && (await this.options.widgetActivated());
          // Retirement or reconnect during the query revokes this request.
          if (options.isCurrent?.() === false) {
            throw new Error("widget link request is no longer current");
          }
          if (!activated || !consumeUserActivation() || !postNativeExternalLink(url)) {
            throw new Error("widget link could not be opened");
          }
        } else {
          // noopener may return null even after opening; it is not a failure receipt.
          openExternalUrlSafe(url);
        }
        return { ok: true };
      }
      case "prompt.send": {
        if (options.promptUserActivated !== true) {
          throw new Error("widget prompt requires active user interaction");
        }
        const text = requiredString(params, "text");
        const authorization = (await this.options.client.request("board.prompt.authorize", {
          ticket: this.options.ticket,
        })) as { confirmationRequired?: boolean };
        if (options.isCurrent?.() === false) {
          throw new Error("widget prompt request is no longer current");
        }
        const accepted = await dispatchWidgetPrompt(
          this.options.frame,
          text,
          this.options.rateKey,
          authorization.confirmationRequired === false ? undefined : this.options.confirmPrompt,
          options.isCurrent,
          request.ticket,
        );
        if (!accepted) {
          throw new Error("widget prompt was not accepted");
        }
        return { ok: true };
      }
      case "state.emit":
        return await this.emitState(params.payload);
      case "data.query":
      case "data.read":
      case "action.run": {
        const read = request.method !== "action.run";
        const key = request.method === "data.query" ? "queryName" : read ? "bindingId" : "action";
        const target = requiredString(params, key);
        const callParams = key === "queryName" ? undefined : params.params;
        if (callParams !== undefined && !isRecord(callParams)) {
          throw new Error(
            read ? "widget data binding params are invalid" : "widget action params are invalid",
          );
        }
        const boundAction = !read && this.options.actionBindingNames?.().includes(target);
        if (boundAction) {
          const activated =
            request.userActivated === true &&
            navigator.userActivation?.isActive &&
            (await this.options.widgetActivated());
          if (options.isCurrent?.() === false) {
            throw new Error("Widget request retired");
          }
          if (!activated || !consumeUserActivation()) {
            throw new Error("Named actions require a fresh user interaction with this component");
          }
        }
        return await this.options.client.request(read ? "board.data.read" : "board.action", {
          ticket: this.options.ticket,
          [boundAction ? "bindingName" : key]: target,
          ...(read && callParams === undefined ? {} : { params: callParams ?? {} }),
        });
      }
      case "cron.trigger":
        return await this.options.client.request("board.action", {
          ticket: this.options.ticket,
          action: "cron.trigger",
          jobId: requiredString(params, "jobId"),
        });
      default:
        throw new Error(`widget host method is not supported: ${request.method}`);
    }
  }
}
