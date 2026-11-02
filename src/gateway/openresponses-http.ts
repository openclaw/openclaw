import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isClientToolNameConflictError } from "../agents/agent-tool-definition-adapter.js";
import type { ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { toOpenAiResponsesUsage } from "../agents/usage.js";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayHttpResponsesConfig } from "../config/types.gateway.js";
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
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendInvalidRequest, sendJson, sendUnauthorized, setSseHeaders } from "./http-common.js";
import { assertGatewayHttpRequestCurrent } from "./http-request-authority.js";
import { rejectDisabledGatewayUpload } from "./http-upload-policy.js";
import {
  type AuthorizedGatewayHttpRequest,
  authorizeOpenAiCompatibleHttpSession,
  getBearerToken,
  getHeader,
  isGatewayAgentRequestError,
  isGatewayRequestContextError,
  resolveAgentIdForRequest,
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
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
  readOpenAiHttpRunTerminal,
  runOpenAiCompatibleAgentCommand,
  type OpenAiCompatibleHttpOptions,
} from "./openai-compatible-agent-run.js";
import {
  prepareOpenAiCompatibleHttpRequest,
  sendOpenAiCompatibleJsonResponse,
  startOpenAiCompatibleStream,
} from "./openai-compatible-http.js";
import { resolveResponsesLimits } from "./openai-compatible-input-limits.js";
import { applyToolChoice, resolveResponsesToolChoice } from "./openai-tool-choice.js";
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

function extractUsageFromResult(result: unknown): Usage | undefined {
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
  const handled = await prepareOpenAiCompatibleHttpRequest(req, res, {
    ...opts,
    pathname: "/v1/responses",
    maxBodyBytes,
    schema: CreateResponseBodySchema,
  });
  if (!handled) {
    return handled !== false;
  }
  const { payload, abortController, senderIsOwner } = handled;
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
  let resolved: Awaited<ReturnType<typeof resolveGatewayRequestContext>>;
  try {
    resolved = await resolveGatewayRequestContext({
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
  const sessionAuth = await authorizeOpenAiCompatibleHttpSession({
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
  const outputItemId = `msg_${randomUUID()}`;
  const createFailedResponse = (
    error: { code: string; message: string },
    usage?: Usage,
    incompleteTurnText?: string,
  ): ResponseResource =>
    createResponseResource({
      ...responseIdentity,
      model,
      status: "failed",
      output:
        incompleteTurnText === undefined
          ? []
          : [
              createAssistantOutputItem({
                id: outputItemId,
                text: incompleteTurnText,
                phase: "final_answer",
                status: "incomplete",
              }),
            ],
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
    return sendOpenAiCompatibleJsonResponse({
      res,
      signal: abortController.signal,
      constraint: toolChoice.constraint,
      run: runAgentCommand,
      failureLabel: "openresponses: non-stream response failed",
      complete: ({ result, stopReason, toolCalls, text: assistantText, toolChoiceError }) => {
        const usage = extractUsageFromResult(result);

        if (toolChoiceError) {
          const failed = createFailedResponse(
            {
              code: "api_error",
              message: toolChoiceError,
            },
            usage,
          );
          sendJson(res, 502, failed);
          return;
        }

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
      },
      fail: (mapped, result, incompleteTurnText) =>
        sendJson(
          res,
          mapped.status,
          createFailedResponse(
            {
              code: incompleteTurnText === undefined ? mapped.error.type : "incomplete_turn",
              message: mapped.error.message,
            },
            result === undefined ? undefined : extractUsageFromResult(result),
            incompleteTurnText,
          ),
        ),
    });
  }

  setSseHeaders(res);

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

  startOpenAiCompatibleStream({
    protocol: "responses",
    res,
    runId: responseId,
    signal: abortController.signal,
    constraint: toolChoice.constraint,
    run: runAgentCommand,
    writeDelta: (delta) =>
      writeSseEvent(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta,
      }),
    complete: ({
      result,
      text: finalText,
      delta,
      toolCalls: finalToolCalls,
      stopReason,
      lifecycleError,
    }) => {
      const usage = extractUsageFromResult(result);
      const status = lifecycleError
        ? "failed"
        : stopReason === "length"
          ? "incomplete"
          : "completed";
      if (delta) {
        writeSseEvent(res, {
          type: "response.output_text.delta",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          delta,
        });
      }
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
        phase: !lifecycleError && !finalToolCalls ? "final_answer" : "commentary",
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
        ...(lifecycleError
          ? {
              error: {
                code: "server_error",
                message: lifecycleError,
              },
            }
          : {}),
      });

      writeSseEvent(res, {
        type: `response.${status}`,
        response: finalResponse,
      });
    },
    fail: (error, result, incompleteTurnText) =>
      writeSseEvent(res, {
        type: "response.failed",
        response: createFailedResponse(
          {
            code: incompleteTurnText === undefined ? error.type : "incomplete_turn",
            message: error.message,
          },
          result === undefined ? undefined : extractUsageFromResult(result),
          incompleteTurnText,
        ),
      }),
  });
  return true;
}
