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
    },
  ) {
    this.options = { ...options };
  }

  updateIdentity(frame: HTMLIFrameElement, ticket: string): void {
    this.options.frame = frame;
    this.options.ticket = ticket;
  }

  // The native route skips WebKit's popup blocker, so it keeps that blocker's
  // rules: the dashboard and this widget's own sandbox frame must both hold
  // live user activation, and each open spends it. Activation reaches that
  // frame only from input inside this widget, so code that took the wrapper's
  // port cannot open links on input elsewhere, and one gesture opens one link.
  private async openNativeLink(url: string, isCurrent?: () => boolean): Promise<boolean> {
    if (!hasNativeExternalLink() || !navigator.userActivation?.isActive) {
      return false;
    }
    const widgetActivated = await this.options.widgetActivated();
    // Widget retirement or a Gateway reconnect during the query revokes the
    // request. The native receiver cannot tell, so neither opener may run.
    if (isCurrent?.() === false) {
      throw new Error("widget link request is no longer current");
    }
    return widgetActivated && consumeUserActivation() && postNativeExternalLink(url);
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
        if (!/^https?:\/\//i.test(url)) {
          throw new Error("widget link url is invalid");
        }
        // A request the native route refuses falls through to window.open,
        // which WebKit's popup blocker refuses as it does on main.
        if (!(await this.openNativeLink(url, options.isCurrent)) && !openExternalUrlSafe(url)) {
          throw new Error("widget link could not be opened");
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
        );
        if (!accepted) {
          throw new Error("widget prompt was not accepted");
        }
        return { ok: true };
      }
      case "state.emit":
        return await this.emitState(params.payload);
      case "data.read":
      case "action.run": {
        const read = request.method === "data.read";
        const key = read ? "bindingId" : "action";
        const target = requiredString(params, key);
        const callParams = params.params;
        if (callParams !== undefined && !isRecord(callParams)) {
          throw new Error(
            read ? "widget data binding params are invalid" : "widget action params are invalid",
          );
        }
        return await this.options.client.request(read ? "board.data.read" : "board.action", {
          ticket: this.options.ticket,
          [key]: target,
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
