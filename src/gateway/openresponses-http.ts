import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isClientToolNameConflictError } from "../agents/agent-tool-definition-adapter.js";
import type { ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { toOpenAiResponsesUsage } from "../agents/usage.js";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayHttpResponsesConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEventForRun } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import {
  renderFileAttachmentOutcome,
  resolveFileExtractionOutcome,
} from "../media-understanding/file-attachment-outcomes.js";
import { renderFileContextBlock } from "../media/file-context.js";
import {
  extractFileContentFromSource,
  extractImageContentFromSource,
} from "../media/input-files.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../process/gateway-work-admission.js";
import {
  createAssistantTextStream,
  resolveAssistantResultText,
} from "./agent-event-assistant-text.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  parseGatewayJsonRequest,
  retainGatewayHttpResponseWork,
  sendInvalidRequest,
  sendJson,
  sendMissingScopeForbidden,
  sendUnauthorized,
  setSseHeaders,
  watchClientDisconnect,
  writeDone,
} from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { assertGatewayHttpRequestCurrent } from "./http-request-authority.js";
import { rejectDisabledGatewayUpload } from "./http-upload-policy.js";
import {
  type AuthorizedGatewayHttpRequest,
  authorizeOpenAiCompatibleHttpModelOverride,
  authorizeOpenAiCompatibleHttpSession,
  getBearerToken,
  getHeader,
  isGatewayAgentRequestError,
  isGatewayRequestContextError,
  resolveAgentIdForRequest,
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import {
  CreateResponseBodySchema,
  type OutputItem,
  type ResponseResource,
  type StreamingEvent,
  type Usage,
} from "./open-responses.schema.js";
import { resolveAgentRunUsage } from "./openai-agent-run-usage.js";
import { resolveOpenAiStreamParams } from "./openai-compat-errors.js";
import {
  type OpenAiCompatiblePendingToolCall,
  readOpenAiHttpRunTerminal,
  resolveOpenAiCompatibleAgentError,
  runOpenAiCompatibleAgentCommand,
  type OpenAiCompatibleHttpOptions,
} from "./openai-compatible-agent-run.js";
import { resolveResponsesLimits } from "./openai-compatible-input-limits.js";
import {
  applyToolChoice,
  resolveResponsesToolChoice,
  resolveToolChoiceConstraintError,
} from "./openai-tool-choice.js";
import { buildAgentPrompt } from "./openresponses-prompt.js";
import { lookupResponseSession, rememberResponseSession } from "./openresponses-session-store.js";
import {
  createAssistantOutputItem,
  createFunctionCallOutputItem,
  createResponseResource,
} from "./openresponses-shape.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

function resolveResponseSessionAuthSubject(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  requestAuth: AuthorizedGatewayHttpRequest;
  resolveGatewayContext?: GatewayContextResolver;
}): string {
  // Proxy-verified identity owns continuation; forwarded bearers are unverified.
  if (params.requestAuth.authMethod === "trusted-proxy") {
    return `trusted-proxy:${params.requestAuth.user}`;
  }
  const bearer = getBearerToken(params.req);
  if (bearer) {
    const projector = params.resolveGatewayContext?.()?.configRevisionProjector;
    if (!projector) {
      throw new Error("OpenResponses bearer scope requires a current Gateway context.");
    }
    return `bearer:${projector.hashResponseSessionBearer(bearer)}`;
  }
  return `gateway-auth:${params.auth.mode}`;
}

function writeSseEvent(res: ServerResponse, event: StreamingEvent) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function extractUsageFromResult(result: unknown): Usage {
  return toOpenAiResponsesUsage(resolveAgentRunUsage(result));
}

export async function handleOpenResponsesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiCompatibleHttpOptions<GatewayHttpResponsesConfig>,
): Promise<boolean> {
  const limits = resolveResponsesLimits(opts.config);
  const maxBodyBytes =
    opts.maxBodyBytes ??
    Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2);
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    ...opts,
    pathname: "/v1/responses",
    requiredOperatorMethod: "chat.send",
    maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  const abortController = new AbortController();
  // The signal owns preparation; SSE installs presentation cleanup below.
  let onDisconnect = () => {};
  watchClientDisconnect(req, res, abortController, () => onDisconnect());
  const modelOverrideAuth = authorizeOpenAiCompatibleHttpModelOverride(req, handled.requestAuth);
  if (!modelOverrideAuth.allowed) {
    sendMissingScopeForbidden(res, modelOverrideAuth.missingScope);
    return true;
  }
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);
  const payload = parseGatewayJsonRequest(res, handled.body, CreateResponseBodySchema);
  if (!payload) {
    return true;
  }
  const hasMedia =
    Array.isArray(payload.input) &&
    payload.input.some(
      (item) =>
        item.type === "message" &&
        Array.isArray(item.content) &&
        item.content.some((part) => part.type === "input_image" || part.type === "input_file"),
    );
  if (rejectDisabledGatewayUpload(res, hasMedia)) {
    return true;
  }
  const stream = Boolean(payload.stream);
  const model = payload.model;
  const user = payload.user;
  let agentId: string;
  try {
    agentId = resolveAgentIdForRequest({ req, model });
  } catch (err) {
    if (isGatewayAgentRequestError(err)) {
      sendInvalidRequest(res, err.message);
      return true;
    }
    throw err;
  }
  const creationAuth = authorizeGatewaySessionCreation({
    cfg: getRuntimeConfig(),
    ...(handled.requestAuth.operatorRoleActor
      ? { actor: handled.requestAuth.operatorRoleActor }
      : { profileId: handled.requestAuth.authenticatedUserProfile?.profileId }),
    agentId,
  });
  if (creationAuth) {
    sendJson(res, 403, {
      error: { message: creationAuth.message, type: "forbidden" },
    });
    return true;
  }
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendInvalidRequest(res, modelError);
    return true;
  }

  const prompt = buildAgentPrompt(payload.input);

  // Count URL sources request-wide, but replay media only from the current user turn.
  let images: ImageContent[] = [];
  const fileContexts: string[] = [];
  let urlParts = 0;
  const markUrlPart = () => {
    urlParts += 1;
    if (urlParts > limits.maxUrlParts) {
      throw new Error(
        `Too many URL-based input sources: ${urlParts} (limit: ${limits.maxUrlParts})`,
      );
    }
  };
  try {
    abortController.signal.throwIfAborted();
    if (Array.isArray(payload.input)) {
      for (const item of payload.input) {
        if (item.type === "message" && typeof item.content !== "string") {
          for (const part of item.content) {
            if (part.type !== "input_image" && part.type !== "input_file") {
              continue;
            }
            assertGatewayHttpRequestCurrent(handled.requestAuth);
            if (rejectDisabledGatewayUpload(res, hasMedia)) {
              return true;
            }
            if (part.source.type === "url") {
              markUrlPart();
            }
            if (item !== prompt.activeUserMessage) {
              continue;
            }
            const source = part.source;
            const inputSource =
              source.type === "url"
                ? source
                : {
                    type: source.type,
                    data: source.data,
                    mediaType: source.media_type,
                    filename: "filename" in source ? source.filename : undefined,
                  };
            if (part.type === "input_image") {
              const image = await extractImageContentFromSource(
                inputSource,
                limits.images,
                abortController.signal,
              );
              images.push(image);
              continue;
            }

            const file = await extractFileContentFromSource({
              source: inputSource,
              limits: limits.files,
              signal: abortController.signal,
            });
            const outcome = resolveFileExtractionOutcome(file);
            const content = renderFileAttachmentOutcome(outcome);
            if (content !== null) {
              fileContexts.push(
                renderFileContextBlock({
                  filename: file.filename,
                  content,
                  surroundContentWithNewlines: outcome.kind === "extracted",
                }),
              );
            }
            if (file.images && file.images.length > 0) {
              images = images.concat(file.images);
            }
          }
        }
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      return true;
    }
    if (handled.requestAuth.hasCurrentClientAuthority?.() === false) {
      sendUnauthorized(res);
      return true;
    }
    if (rejectDisabledGatewayUpload(res, hasMedia)) {
      return true;
    }
    logWarn(`openresponses: request parsing failed: ${String(err)}`);
    sendInvalidRequest(res, "invalid request");
    return true;
  }

  // Preparation can yield across a runtime policy publication, including the last file.
  if (rejectDisabledGatewayUpload(res, hasMedia)) {
    return true;
  }
  const clientTools: ClientToolDefinition[] = (payload.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  }));
  let toolChoice: ReturnType<typeof applyToolChoice>;
  try {
    toolChoice = applyToolChoice(clientTools, resolveResponsesToolChoice(payload.tool_choice));
  } catch (err) {
    logWarn(`openresponses: tool configuration failed: ${String(err)}`);
    sendInvalidRequest(res, "invalid tool configuration");
    return true;
  }
  let resolved: ReturnType<typeof resolveGatewayRequestContext>;
  try {
    resolved = resolveGatewayRequestContext({
      req,
      model,
      user,
      sessionPrefix: "openresponses",
    });
  } catch (err) {
    if (isGatewayRequestContextError(err)) {
      sendInvalidRequest(res, err.message);
      return true;
    }
    throw err;
  }
  const responseSessionScope = {
    authSubject: resolveResponseSessionAuthSubject({
      req,
      auth: opts.auth,
      requestAuth: handled.requestAuth,
      resolveGatewayContext: opts.resolveGatewayContext,
    }).trim(),
    agentId: resolved.agentId,
    requestedSessionKey: getHeader(req, "x-openclaw-session-key")?.trim() || undefined,
  };
  // Resolve session key: reuse previous_response_id only when it matches the
  // same auth-subject/agent/requested-session scope as the current request.
  const previousSessionKey = payload.previous_response_id
    ? await lookupResponseSession({
        ...responseSessionScope,
        responseId: payload.previous_response_id,
      })
    : undefined;
  if (handled.requestAuth.hasCurrentClientAuthority?.() === false) {
    sendUnauthorized(res);
    return true;
  }
  if (payload.previous_response_id !== undefined && !previousSessionKey) {
    sendInvalidRequest(
      res,
      "Cannot resolve previous_response_id. Retry with full input context and omit previous_response_id.",
    );
    return true;
  }
  const sessionKey = previousSessionKey ?? resolved.sessionKey;
  const messageChannel = resolved.messageChannel;
  const sessionAuth = authorizeOpenAiCompatibleHttpSession({
    agentId: resolved.agentId,
    sessionKey,
    requestAuth: handled.requestAuth,
    senderIsOwner,
  });
  if (!sessionAuth.allowed) {
    sendJson(res, 403, { error: { message: sessionAuth.message, type: "forbidden" } });
    return true;
  }

  const fileContext = fileContexts.length > 0 ? fileContexts.join("\n\n") : undefined;
  const toolChoiceContext = toolChoice.extraSystemPrompt?.trim();

  const extraSystemPrompt = [
    payload.instructions,
    prompt.extraSystemPrompt,
    toolChoiceContext,
    fileContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!prompt.message) {
    sendInvalidRequest(res, "Missing user message in `input`.");
    return true;
  }

  const responseId = `resp_${randomUUID()}`;
  const responseIdentity = { id: responseId, createdAt: Math.floor(Date.now() / 1000) };
  const createFailedResponse = (
    error: { code: string; message: string },
    usage?: Usage,
  ): ResponseResource =>
    createResponseResource({
      ...responseIdentity,
      model,
      status: "failed",
      output: [],
      error,
      usage,
    });
  const rememberSession = () =>
    rememberResponseSession({ ...responseSessionScope, responseId, sessionKey }, () =>
      assertGatewayHttpRequestCurrent(handled.requestAuth),
    );
  const rememberSessionAfterFailure = async () => {
    try {
      await rememberSession();
    } catch (persistenceError) {
      logWarn(
        `openresponses: continuity persistence failed after run error: ${String(persistenceError)}`,
      );
    }
  };
  const outputItemId = `msg_${randomUUID()}`;
  const streamParams = resolveOpenAiStreamParams({
    maxTokens: payload.max_output_tokens,
    temperature: payload.temperature,
    topP: payload.top_p,
  });
  const runAgentCommand = async () => {
    let result;
    try {
      result = await runOpenAiCompatibleAgentCommand({
        message: prompt.message,
        images,
        clientTools: toolChoice.tools,
        extraSystemPrompt,
        modelOverride,
        streamParams,
        agentId,
        sessionKey,
        runId: responseId,
        messageChannel,
        senderIsOwner,
        requestAuth: handled.requestAuth,
        operatorScopes: handled.operatorScopes,
        resolveGatewayContext: opts.resolveGatewayContext,
        abortSignal: abortController.signal,
        hasCurrentClientAuthority: handled.requestAuth.hasCurrentClientAuthority,
        hasClientUploads: hasMedia,
      });
    } catch (error) {
      if (!abortController.signal.aborted && !isClientToolNameConflictError(error)) {
        await rememberSessionAfterFailure();
      }
      throw error;
    }
    if (abortController.signal.aborted) {
      return result;
    }
    // Commit continuity before either JSON or SSE can publish a terminal response.
    // A failed run keeps its own error response; only a successful run fails on persistence,
    // so it reports HTTP 500 / response.failed instead of an uncontinuable success.
    if (readOpenAiHttpRunTerminal(result).runFailed) {
      await rememberSessionAfterFailure();
    } else {
      await rememberSession();
    }
    return result;
  };

  if (!stream) {
    try {
      const result = await runAgentCommand();

      if (abortController.signal.aborted) {
        return true;
      }

      const { runFailed, stopReason, pendingToolCalls } = readOpenAiHttpRunTerminal(result);
      if (runFailed) {
        throw new Error("agent run failed");
      }
      const assistantText = resolveAssistantResultText(result);
      const usage = extractUsageFromResult(result);

      const toolChoiceError = resolveToolChoiceConstraintError(
        toolChoice.constraint,
        pendingToolCalls,
      );
      if (toolChoiceError) {
        const failed = createFailedResponse(
          {
            code: "api_error",
            message: toolChoiceError,
          },
          usage,
        );
        sendJson(res, 502, failed);
        return true;
      }

      const toolCalls =
        stopReason === "tool_calls" && pendingToolCalls?.length ? pendingToolCalls : undefined;
      const status = stopReason === "length" ? "incomplete" : "completed";
      const output: OutputItem[] = [];
      if (assistantText || !toolCalls) {
        output.push(
          createAssistantOutputItem({
            id: outputItemId,
            text: assistantText || "No response from OpenClaw.",
            phase: toolCalls ? "commentary" : "final_answer",
            status,
          }),
        );
      }
      for (const functionCall of toolCalls ?? []) {
        output.push(
          createFunctionCallOutputItem({
            id: `call_${randomUUID()}`,
            callId: functionCall.id,
            name: functionCall.name,
            arguments: functionCall.arguments,
          }),
        );
      }
      const response = createResponseResource({
        ...responseIdentity,
        model,
        status,
        output,
        usage,
      });

      sendJson(res, 200, response);
    } catch (err) {
      if (abortController.signal.aborted) {
        return true;
      }
      logWarn(`openresponses: non-stream response failed: ${String(err)}`);
      const mapped = resolveOpenAiCompatibleAgentError(err);
      sendJson(
        res,
        mapped.status,
        createFailedResponse({ code: mapped.error.type, message: mapped.error.message }),
      );
    }
    return true;
  }

  setSseHeaders(res);

  const textStream = createAssistantTextStream(Boolean(toolChoice.constraint));
  let finalResultText: string | undefined;
  let finalToolCalls: OpenAiCompatiblePendingToolCall[] | undefined;
  let unrepresentableAssistantReplacement = false;
  let closed = false;
  let unsubscribe = () => {};
  let finalUsage: Usage | undefined;
  let finalOutputStatus: "completed" | "incomplete" = "completed";
  let finalizeRequested: { status: "completed" | "failed"; errorMessage?: string } | null = null;
  let finalizeScheduled = false;
  let terminalLifecyclePhase: "end" | "error" = "end";

  const maybeFinalize = () => {
    if (closed || finalizeScheduled) {
      return;
    }
    if (!finalizeRequested) {
      return;
    }
    // finalUsage is set only after runAgentCommand settles, which commits response
    // continuity first; lifecycle events alone must never publish a terminal event.
    if (!finalUsage) {
      return;
    }
    // Lifecycle listeners can queue assistant flushes after this listener runs;
    // the next turn preserves all same-turn deltas before the terminal snapshot.
    finalizeScheduled = true;
    setImmediate(() => {
      if (closed || !finalizeRequested || !finalUsage) {
        return;
      }
      if (unrepresentableAssistantReplacement) {
        finalizeUnrepresentableAssistantReplacement();
        return;
      }
      const usage = finalUsage;
      const status = finalizeRequested.status === "failed" ? "failed" : finalOutputStatus;
      const finalText = textStream.complete(
        finalResultText,
        finalToolCalls ? "" : "No response from OpenClaw.",
      );
      if (!finalText.startsWith(textStream.streamedText)) {
        finalizeUnrepresentableAssistantReplacement();
        return;
      }
      const delta = finalText.slice(textStream.streamedText.length);
      if (delta) {
        writeSseEvent(res, {
          type: "response.output_text.delta",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          delta,
        });
      }
      closed = true;
      unsubscribe();

      writeSseEvent(res, {
        type: "response.output_text.done",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        text: finalText,
      });

      writeSseEvent(res, {
        type: "response.content_part.done",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: finalText },
      });

      const completedItem = createAssistantOutputItem({
        id: outputItemId,
        text: finalText,
        phase:
          finalizeRequested.status === "completed" && !finalToolCalls
            ? "final_answer"
            : "commentary",
        status: status === "incomplete" ? "incomplete" : "completed",
      });

      writeSseEvent(res, {
        type: "response.output_item.done",
        output_index: 0,
        item: completedItem,
      });

      const output: OutputItem[] = [completedItem];
      for (const functionCall of finalToolCalls ?? []) {
        const item = createFunctionCallOutputItem({
          id: `call_${randomUUID()}`,
          callId: functionCall.id,
          name: functionCall.name,
          arguments: functionCall.arguments,
        });
        const outputIndex = output.length;
        writeSseEvent(res, {
          type: "response.output_item.added",
          output_index: outputIndex,
          item,
        });
        const completedCall: OutputItem = { ...item, status: "completed" };
        writeSseEvent(res, {
          type: "response.output_item.done",
          output_index: outputIndex,
          item: completedCall,
        });
        output.push(completedCall);
      }
      const finalResponse = createResponseResource({
        ...responseIdentity,
        model,
        status,
        output,
        usage,
        ...(finalizeRequested.status === "failed"
          ? {
              error: {
                code: "server_error",
                message: finalizeRequested.errorMessage || "Agent run failed",
              },
            }
          : {}),
      });

      writeSseEvent(res, {
        type: `response.${status}`,
        response: finalResponse,
      });
      writeDone(res);
      res.end();
    });
  };

  const requestFinalize = (status: "completed" | "failed", errorMessage?: string) => {
    if (finalizeRequested) {
      return;
    }
    finalizeRequested = { status, errorMessage };
    maybeFinalize();
  };

  const finalizeFailedResponse = (response: ResponseResource) => {
    if (closed) {
      return;
    }
    // Failure is terminal even when an earlier lifecycle event is waiting for usage.
    closed = true;
    unsubscribe();
    writeSseEvent(res, { type: "response.failed", response });
    writeDone(res);
    res.end();
  };

  const finalizeUnrepresentableAssistantReplacement = () => {
    const usage = finalUsage;
    if (!usage) {
      return;
    }
    finalizeFailedResponse(
      createFailedResponse(
        {
          code: "server_error",
          message: "Assistant output cannot be represented as an append-only response stream.",
        },
        usage,
      ),
    );
  };

  const initialResponse = createResponseResource({
    ...responseIdentity,
    model,
    status: "in_progress",
    output: [],
  });

  writeSseEvent(res, { type: "response.created", response: initialResponse });
  writeSseEvent(res, { type: "response.in_progress", response: initialResponse });

  // Start empty because content_part.added owns appending content index 0.
  const outputItem = createAssistantOutputItem({
    id: outputItemId,
    text: "",
    status: "in_progress",
  });

  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...outputItem, content: [] },
  });

  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  unsubscribe = onAgentEventForRun(responseId, (evt) => {
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const { delta: content, replacement } = textStream.update(evt.data);
      if (replacement) {
        unrepresentableAssistantReplacement = replacement === "unrepresentable";
      }
      if (!content) {
        return;
      }
      writeSseEvent(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: content,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        const finalStatus = phase === "error" ? "failed" : "completed";
        const errorMessage =
          phase === "error" && typeof evt.data?.error === "string"
            ? evt.data.error.trim()
            : undefined;
        requestFinalize(finalStatus, errorMessage);
      }
    }
  });

  // Agent cleanup and deferred SSE delivery have independent lifetimes;
  // shutdown must wait until both have settled, whichever finishes last.
  const releaseAgentRootWork = retainGatewayRootWorkAdmissionContinuation();
  const releaseStreamRootWork = retainGatewayHttpResponseWork(res);

  onDisconnect = () => {
    closed = true;
    unsubscribe();
    releaseStreamRootWork();
  };

  void (async () => {
    try {
      const result = await runAgentCommand();

      if (closed) {
        return;
      }

      const { runFailed, stopReason, pendingToolCalls } = readOpenAiHttpRunTerminal(result);
      if (runFailed) {
        terminalLifecyclePhase = "error";
        finalizeFailedResponse(
          createFailedResponse(
            { code: "api_error", message: "internal error" },
            extractUsageFromResult(result),
          ),
        );
        return;
      }

      finalUsage = extractUsageFromResult(result);

      // Check for pending client tool calls BEFORE maybeFinalize() because the
      // lifecycle:end event may already have requested finalization.
      const resultPayloadText = resolveAssistantResultText(result);

      const toolChoiceError = resolveToolChoiceConstraintError(
        toolChoice.constraint,
        pendingToolCalls,
      );
      if (toolChoiceError) {
        const failed = createFailedResponse(
          {
            code: "api_error",
            message: toolChoiceError,
          },
          finalUsage,
        );
        finalizeFailedResponse(failed);
        return;
      }

      finalResultText = resultPayloadText;
      finalOutputStatus = stopReason === "length" ? "incomplete" : "completed";
      finalToolCalls =
        stopReason === "tool_calls" && pendingToolCalls?.length ? pendingToolCalls : undefined;
      maybeFinalize();
    } catch (err) {
      if (closed || abortController.signal.aborted) {
        return;
      }
      terminalLifecyclePhase = "error";
      logWarn(`openresponses: streaming response failed: ${String(err)}`);

      finalUsage = finalUsage ?? toOpenAiResponsesUsage(undefined);
      const mapped = resolveOpenAiCompatibleAgentError(err);
      finalizeFailedResponse(
        createFailedResponse(
          { code: mapped.error.type, message: mapped.error.message },
          finalUsage,
        ),
      );
    } finally {
      releaseAgentRootWork?.();
      // Existing provider terminals must not be replaced or emitted twice.
      if (finalizeRequested === null && (terminalLifecyclePhase === "error" || !closed)) {
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: terminalLifecyclePhase },
        });
      }
    }
  })();

  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
