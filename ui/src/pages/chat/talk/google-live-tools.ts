import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { formatUiError } from "../../../lib/format-error.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
  type RealtimeTalkEventInput,
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
  emitTalkEvent: (input: RealtimeTalkEventInput) => void;
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
      if (!this.submitResult(callId, { error: message })) {
        return;
      }
      this.options.emitTalkEvent({
        type: "tool.error",
        callId,
        final: true,
        payload: { name, message },
      });
      return;
    }

    this.options.emitTalkEvent({
      type: "tool.call",
      callId,
      payload: { name, args: call.args ?? {} },
    });
    if (name === REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME) {
      this.submitDescribeView(callId);
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
        emitTalkEvent: this.options.emitTalkEvent,
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

  private submitDescribeView(callId: string): void {
    const active = this.options.isDescribeViewActive();
    if (
      !this.submitResult(
        callId,
        active ? { ok: true, cameraStreamActive: true } : { ok: false, error: "camera is off" },
      )
    ) {
      return;
    }
    this.options.emitTalkEvent({
      type: active ? "tool.result" : "tool.error",
      callId,
      final: true,
      payload: {
        name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
        cameraStreamActive: active,
      },
    });
  }

  private submitResult(callId: string, result: unknown): boolean {
    const call = this.pendingCalls.get(callId);
    if (!call || call.cancelled) {
      return false;
    }
    try {
      this.options.sendResult(callId, call.name, result);
    } catch (error) {
      this.options.failConnection(formatUiError(error));
      return false;
    }
    this.pendingCalls.delete(callId);
    return true;
  }
}
