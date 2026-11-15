import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { formatUiError } from "../../../lib/format-error.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
  type RealtimeTalkTransportContext,
} from "./shared.ts";

const GOOGLE_LIVE_MAX_TOOL_CALL_IDS = 1_024;

type GoogleLivePendingToolCall = {
  name: string;
  cancelled: boolean;
  controller?: AbortController;
};

export type GoogleLiveFunctionCall = {
  id?: string;
  name?: string;
  args?: unknown;
};

type GoogleLiveToolOwnerOptions = {
  ctx: RealtimeTalkTransportContext;
  isClosed: () => boolean;
  failConnection: (detail: string) => void;
  isDescribeViewActive: () => boolean;
  sendResult: (callId: string, name: string, result: unknown) => void;
};

export class GoogleLiveToolOwner {
  private readonly pendingCalls = new Map<string, GoogleLivePendingToolCall>();
  private readonly seenCallIds = new Set<string>();

  constructor(private readonly options: GoogleLiveToolOwnerOptions) {}

  release(): void {
    for (const call of this.pendingCalls.values()) {
      call.controller?.abort();
    }
    this.pendingCalls.clear();
    this.seenCallIds.clear();
  }

  hasPendingConsult(): boolean {
    for (const call of this.pendingCalls.values()) {
      if (!call.cancelled && call.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        return true;
      }
    }
    return false;
  }

  async handleCall(call: GoogleLiveFunctionCall): Promise<void> {
    if (this.options.isClosed()) {
      return;
    }
    const name = call.name?.trim();
    const callId = call.id?.trim();
    if (!name || !callId || this.seenCallIds.has(callId)) {
      return;
    }
    // Google exposes no replay window. Eviction could re-execute a very late
    // duplicate, so the session fails closed when lifetime ownership is full.
    if (this.seenCallIds.size >= GOOGLE_LIVE_MAX_TOOL_CALL_IDS) {
      this.options.failConnection("Google Live tool-call session limit exceeded");
      return;
    }
    this.seenCallIds.add(callId);
    const pending: GoogleLivePendingToolCall = { name, cancelled: false };
    this.pendingCalls.set(callId, pending);

    if (
      name !== REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME &&
      name !== REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME &&
      name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
    ) {
      const message = `Tool "${name}" is not available in browser Talk`;
      this.submitResult(callId, { error: message });
      return;
    }

    if (name === REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME) {
      const active = this.options.isDescribeViewActive();
      this.submitResult(
        callId,
        active ? { ok: true, cameraStreamActive: true } : { ok: false, error: "camera is off" },
      );
      return;
    }
    await this.runAgentTool(pending, callId, call.args);
  }

  cancel(ids: string[] | undefined): void {
    for (const rawId of ids ?? []) {
      const callId = rawId.trim();
      const call = this.pendingCalls.get(callId);
      if (!callId || !call || call.cancelled) {
        continue;
      }
      call.cancelled = true;
      if (call.controller) {
        call.controller.abort();
      } else {
        this.pendingCalls.delete(callId);
      }
    }
  }

  private async runAgentTool(
    call: GoogleLivePendingToolCall,
    callId: string,
    args: unknown,
  ): Promise<void> {
    const abortController = new AbortController();
    call.controller = abortController;
    try {
      const { ctx } = this.options;
      const activeContext: RealtimeTalkTransportContext = {
        ...ctx,
        callbacks: {
          onStatus: (status, detail) => {
            if (!this.options.isClosed()) {
              ctx.callbacks.onStatus?.(status, detail);
            }
          },
        },
      };
      const params = {
        ctx: activeContext,
        callId,
        args: args ?? {},
        signal: abortController.signal,
        submit: (toolCallId: string, result: unknown) => {
          this.submitResult(toolCallId, result);
        },
      };
      if (call.name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
        await submitRealtimeTalkAgentControl(params);
      } else {
        await submitRealtimeTalkConsult({ ...params, submitAbortResult: false });
      }
    } finally {
      if (call.cancelled) {
        this.pendingCalls.delete(callId);
        if (
          call.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME &&
          !this.options.isClosed() &&
          !this.hasPendingConsult()
        ) {
          this.options.ctx.callbacks.onStatus?.("listening");
        }
      }
    }
  }

  private submitResult(callId: string, result: unknown): void {
    const call = this.pendingCalls.get(callId);
    if (!call || call.cancelled) {
      return;
    }
    try {
      this.options.sendResult(callId, call.name, result);
    } catch (error) {
      this.options.failConnection(formatUiError(error));
      return;
    }
    this.pendingCalls.delete(callId);
  }
}
