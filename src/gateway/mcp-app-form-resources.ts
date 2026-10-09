import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { QuestionResourceActionResult } from "../../packages/gateway-protocol/src/question-resource.js";
import { captureAgentQuestionAnswerAuthority } from "../agents/harness/host-private-capabilities.js";
import type { StructuredInputResourceContext } from "../agents/harness/structured-input-boundary.js";
import {
  compileStructuredInputForm,
  snapshotStructuredInput,
} from "../agents/harness/structured-input.js";
import {
  registerMcpFormResourceOwner,
  requireMcpFormQuestion,
  type McpFormResourceOwner,
} from "../agents/mcp-form-resource-context.js";
import {
  fetchMcpAppView,
  releaseMcpAppView,
  type McpAppFormOrigin,
  type McpFormResourceUpload,
} from "../agents/mcp-ui-resource.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveMcpAppRequesterId, callMcpAppToolWithElicitation } from "./mcp-app-operations.js";
import { canSelectQuestion } from "./question-access.js";
import {
  prepareQuestionAuthorization,
  withPreparedQuestionSessions,
} from "./question-session-access.js";
import { readArtifactBase64Payload } from "./server-methods/artifacts-base64.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { retainSessionScopedRead } from "./server-methods/session-scoped-read.js";
import { resolveLocalSessionWorkspaceRoot } from "./server-methods/sessions-files.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createWorkspaceUploadBatch } from "./server-methods/workspace-fs.js";
import { captureGatewayClientUploadCommitGuard } from "./upload-policy.js";

type Form = {
  origin: McpAppFormOrigin;
  uploaded: Map<string, Set<string>>;
  uploadResources?: McpFormResourceUpload;
  previewViews: Set<string>;
  owner: McpFormResourceOwner;
  signal: AbortSignal;
  operations: number;
  activeOperations: number;
  uploadedBytes: number;
  uploadedFiles: number;
};
const forms = resolveGlobalSingleton(
  Symbol.for("openclaw.mcpFormResourceBindings"),
  () => new WeakMap<McpFormResourceOwner, Form>(),
);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const routingSchema = z.object({
  sessionKey: z.string().min(1),
  agentId: z.string().min(1).optional(),
  viewId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(256),
  questionId: z.string().min(1).max(256),
});
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), optionIndex: z.number().int().min(0).max(63) }).strict(),
  z
    .object({
      action: z.literal("upload"),
      files: z
        .array(
          z
            .object({
              name: z.string().min(1).max(255),
              mimeType: z.string().max(256),
              content: z.string().max(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4),
              relativePath: z.string().min(1).max(2048).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(64),
    })
    .strict(),
]);

export async function createMcpAppFormResourceContext(params: {
  origin: McpAppFormOrigin;
  snapshot: Record<string, unknown>;
  signal: AbortSignal;
  uploadResources?: McpFormResourceUpload;
}): Promise<{ context: StructuredInputResourceContext; dispose: () => void }> {
  params.signal.throwIfAborted();
  params.origin.assertCurrent();
  const snapshot = snapshotStructuredInput(params.snapshot, { richForm: true });
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Invalid rich form snapshot");
  }
  const questionAuthority = captureAgentQuestionAnswerAuthority(params.origin.sessionKey);
  if (
    params.origin.requesterId !== undefined &&
    questionAuthority?.requesterProfileId !== undefined &&
    params.origin.requesterId !== questionAuthority.requesterProfileId
  ) {
    throw new Error("MCP form requester does not match its question creator");
  }
  const origin = {
    ...params.origin,
    requesterId: params.origin.requesterId ?? questionAuthority?.requesterProfileId,
  };
  const viewId = "mcp-form-" + randomUUID();
  let active = true;
  let unregister = () => {};
  const uploaded = new Map<string, Set<string>>();
  const previewViews = new Set<string>();
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    if (!active) {
      throw new Error("MCP form origin was retired");
    }
    origin.assertCurrent();
    questionAuthority?.assertActive();
    origin.runtime.assertOwnerCurrent?.();
  };
  const dispose = () => {
    if (!active) {
      return;
    }
    active = false;
    unregister();
    params.signal.removeEventListener("abort", dispose);
    for (const id of previewViews) {
      releaseMcpAppView(id, origin.runtime);
    }
    previewViews.clear();
    uploaded.clear();
    owner.pending.clear();
    forms.delete(owner);
  };
  const context: StructuredInputResourceContext = {
    viewId,
    uploads: params.uploadResources !== undefined,
    previews: origin.runtime.readResource !== undefined,
    isUploadedResource: (questionId, uri) => {
      try {
        assertCurrent();
        return uploaded.get(questionId)?.has(uri) === true;
      } catch {
        return false;
      }
    },
  };
  const compiled = compileStructuredInputForm({
    schema: snapshot.requestedSchema,
    message: typeof snapshot.message === "string" ? snapshot.message : undefined,
    fallbackMessage: "MCP server needs input",
    options: {
      protocolName: "OpenAI",
      allowRichForms: true,
      resourceContext: context,
      allowEmptyForm: true,
      minimumChoiceCount: 1,
      allowEnumNames: true,
    },
  });
  if (compiled.kind !== "ready" || compiled.plan.kind !== "form") {
    throw new Error(compiled.kind === "unsupported" ? compiled.message : "Invalid resource form");
  }
  const questions = new Map(
    compiled.plan.fields.map((field) => [field.question.id, field.question]),
  );
  if (
    !origin.prepareToolCall &&
    [...questions.values()].some((question) =>
      question.options?.some((option) => option.preview?.type === "mcp_app_tool"),
    )
  ) {
    throw new Error("Form App previews require an originating tool authority hook");
  }
  const owner: McpFormResourceOwner = {
    sessionKey: origin.sessionKey,
    agentId: origin.agentId,
    assertCurrent,
    questions,
    pending: new Map(),
    dispose,
  };
  forms.set(owner, {
    origin,
    uploaded,
    uploadResources: params.uploadResources,
    previewViews,
    owner,
    signal: params.signal,
    operations: 0,
    activeOperations: 0,
    uploadedBytes: 0,
    uploadedFiles: 0,
  });
  unregister = registerMcpFormResourceOwner(viewId, owner);
  params.signal.addEventListener("abort", dispose, { once: true });
  if (params.signal.aborted) {
    dispose();
    params.signal.throwIfAborted();
  }
  return { context, dispose };
}

function acceptsFile(
  file: { name: string; mimeType: string },
  accepts: readonly string[] | undefined,
): boolean {
  if (!accepts?.length) {
    return true;
  }
  const name = file.name.toLowerCase();
  const mime = file.mimeType.toLowerCase().split(";", 1)[0]!;
  return accepts.some((rule) => {
    const accept = rule.toLowerCase();
    return accept.startsWith(".")
      ? name.endsWith(accept)
      : accept.endsWith("/*")
        ? mime.startsWith(accept.slice(0, -1))
        : mime === accept;
  });
}

/** UI selectors choose only a live owner record; they never supply targets or restrictions. */
export async function executeMcpAppFormResource(
  options: GatewayRequestHandlerOptions,
): Promise<QuestionResourceActionResult> {
  // Parse action fields separately: strict action objects must not treat routing fields as actions.
  const { sessionKey, agentId, viewId, requestId, questionId, ...action } = options.params;
  const routing = routingSchema.parse({ sessionKey, agentId, viewId, requestId, questionId });
  const parsed = { ...routing, ...actionSchema.parse(action) };
  const manager = options.context.questionManager;
  if (!manager || !canSelectQuestion(manager, parsed.requestId, options.client)) {
    throw new Error("Question was not found");
  }
  const record = manager.get(parsed.requestId);
  const observation = record ? manager.observe(record.id, record) : null;
  const question = record?.questions.find((field) => field.questionId === parsed.questionId);
  if (
    !record ||
    record.status !== "pending" ||
    !observation ||
    !question ||
    !record.agentId ||
    record.sessionKey !== parsed.sessionKey ||
    (parsed.agentId && parsed.agentId !== record.agentId) ||
    question.resource?.viewId !== parsed.viewId
  ) {
    throw new Error("Question resource is not pending for this session");
  }
  const owner = requireMcpFormQuestion({ ...routing, agentId: record.agentId, question, record });
  const form = forms.get(owner);
  if (!form || resolveMcpAppRequesterId(options.client) !== form.origin.requesterId) {
    throw new Error("Question resource is not owned by this requester");
  }
  if (form.operations >= 120 || form.activeOperations >= 4) {
    throw new Error("MCP form resource request limit reached");
  }
  form.operations += 1;
  const caller = readGatewayRequestMutationAuthority(options);
  const read = retainSessionScopedRead(options, record.sessionKey, record.agentId);
  const authorized = prepareQuestionAuthorization(
    options,
    observation,
    record.id,
    parsed.action === "upload" ? "mutate" : "read",
  );
  const assertCurrent = () => {
    caller.assertCurrent();
    options.sessionMutationAuthorization?.assertCurrent();
    read?.assertCurrent();
    owner.assertCurrent();
    if (options.context.getRuntimeConfig().mcp?.apps?.enabled !== true) {
      throw new Error("MCP App runtime is unavailable");
    }
    if (
      manager.get(record.id) !== record ||
      !observation.isCurrent() ||
      record.status !== "pending" ||
      resolveMcpAppRequesterId(options.client) !== form.origin.requesterId ||
      owner.pending.get(record.id)?.record !== record
    ) {
      throw new Error("Question resource authority expired");
    }
  };
  form.activeOperations += 1;
  try {
    await withPreparedQuestionSessions(
      options,
      [authorized.target],
      ([prepared]) => {
        const error = authorized.authorize(prepared);
        if (error) {
          throw new Error(error.message);
        }
      },
      { assertCurrent },
    );
    assertCurrent();
    if (parsed.action === "preview") {
      return await preview(form, options, question, parsed.optionIndex, assertCurrent);
    }
    const restrictions = question.resource?.userOptions;
    if (!restrictions || !form.uploadResources) {
      throw new Error("This question does not permit uploads");
    }
    const assertUpload = captureGatewayClientUploadCommitGuard({
      method: "mcp.app.formResource",
      requestParams: options.params,
      client: options.client,
      context: options.context,
    });
    assertUpload?.();
    let bytes = 0;
    const files = parsed.files.map((file) => {
      if (!acceptsFile(file, restrictions.accept)) {
        throw new Error("File does not match this question’s upload restrictions");
      }
      const encoded = readArtifactBase64Payload(file.content, { includeData: true });
      if (!encoded?.data && file.content !== "") {
        throw new Error("Invalid upload encoding");
      }
      bytes += encoded?.sizeBytes ?? 0;
      if (bytes > MAX_UPLOAD_BYTES) {
        throw new Error("Form upload exceeds the byte limit");
      }
      return {
        name: file.name,
        mimeType: file.mimeType,
        data: Buffer.from(encoded?.data ?? "", "base64"),
        relativePath: file.relativePath || undefined,
      };
    });
    if (form.uploadedBytes + bytes > MAX_UPLOAD_BYTES || form.uploadedFiles + files.length > 64) {
      throw new Error("MCP form upload budget exceeded");
    }
    form.uploadedBytes += bytes;
    form.uploadedFiles += files.length;
    const resources = await form.uploadResources({
      options,
      kind: restrictions.kind,
      files,
      assertCurrent: () => {
        assertCurrent();
        assertUpload?.();
      },
    });
    assertCurrent();
    assertUpload?.();
    if (
      !resources.length ||
      resources.length > 64 ||
      resources.some((resource) => !resource.name || !URL.canParse(resource.uri))
    ) {
      throw new Error("Upload provider returned invalid resources");
    }
    const admitted = form.uploaded.get(question.questionId) ?? new Set<string>();
    for (const resource of resources) {
      admitted.add(resource.uri);
    }
    form.uploaded.set(question.questionId, admitted);
    return { resources };
  } finally {
    form.activeOperations -= 1;
    read?.release();
  }
}

async function preview(
  form: Form,
  options: GatewayRequestHandlerOptions,
  question: {
    options: Array<{
      preview?: import("../../packages/gateway-protocol/src/schema/questions.js").QuestionResourcePreview;
    }>;
  },
  index: number,
  assertCurrent: () => void,
): Promise<QuestionResourceActionResult> {
  const target = question.options[index]?.preview;
  if (!target) {
    throw new Error("This option has no preview");
  }
  const { origin } = form;
  if (target.type === "resource_link") {
    if (!origin.runtime.readResource) {
      throw new Error("Originating server cannot read resources");
    }
    const result = ReadResourceResultSchema.parse(
      await origin.runtime.readResource(origin.serverName, target.uri),
    );
    assertCurrent();
    if (JSON.stringify(result.contents).length > MAX_UPLOAD_BYTES * 2) {
      throw new Error("Resource preview exceeds the byte limit");
    }
    return {
      preview: {
        contents: result.contents.map((content) =>
          "text" in content
            ? { mimeType: content.mimeType || undefined, text: content.text }
            : { mimeType: content.mimeType || undefined, blob: content.blob },
        ),
      },
    };
  }
  const catalog = await origin.runtime.getCatalog();
  assertCurrent();
  const tool = catalog.tools.find(
    (entry) => entry.serverName === origin.serverName && entry.toolName === target.name,
  );
  if (
    !tool?.uiResourceUri ||
    tool.excludedFromOpenClawCatalog ||
    tool.deniedBySession ||
    !origin.prepareToolCall
  ) {
    throw new Error("Preview App tool is unavailable");
  }
  const input = target.arguments ?? {};
  const assertPreparedPolicy = await origin.prepareToolCall({
    options,
    toolName: target.name,
    input,
    assertCurrent,
    signal: form.signal,
  });
  const assertExecutionCurrent = () => {
    assertCurrent();
    if (assertPreparedPolicy) {
      assertPreparedPolicy();
    }
  };
  assertExecutionCurrent();
  const result = await callMcpAppToolWithElicitation({
    options,
    origin,
    toolName: target.name,
    input,
    assertCurrent: assertExecutionCurrent,
    signal: form.signal,
    uploadResources: form.uploadResources,
  });
  assertExecutionCurrent();
  if (result.isError) {
    throw new Error("Preview App tool failed");
  }
  const descriptor = await fetchMcpAppView({
    runtime: origin.runtime,
    agentId: origin.agentId,
    serverName: origin.serverName,
    toolName: target.name,
    uiResourceUri: tool.uiResourceUri,
    toolInput: input,
    toolResult: result,
    requesterId: origin.requesterId,
    allowedAppToolNames: new Set(
      catalog.tools
        .filter(
          (entry) =>
            entry.serverName === origin.serverName &&
            !entry.excludedFromOpenClawCatalog &&
            !entry.deniedBySession &&
            (entry.uiVisibility === undefined || entry.uiVisibility.includes("app")),
        )
        .map((entry) => entry.toolName),
    ),
    prepareToolCall: origin.prepareToolCall,
    uploadResources: form.uploadResources,
    authorizeAppInteraction: () => {
      form.owner.assertCurrent();
      return true;
    },
  });
  if (!descriptor) {
    throw new Error("Preview App resource is unavailable");
  }
  form.previewViews.add(descriptor.viewId);
  assertCurrent();
  return { preview: { viewId: descriptor.viewId } };
}

/** Only a host adapter that proved this originating server can read the local workspace may opt in. */
export function createMcpAppWorkspaceUploadProvider(params: {
  workspaceDir: string;
  sessionKey: string;
  agentId: string;
  assertCurrent: () => void;
}): McpFormResourceUpload {
  return async (request) => {
    const assertCurrent = () => {
      params.assertCurrent();
      request.assertCurrent();
      if (resolveLocalSessionWorkspaceRoot(params) !== params.workspaceDir) {
        throw new Error("Form upload workspace authority changed");
      }
    };
    const files = request.files.map((file) => {
      if (
        file.name.includes("/") ||
        file.name.includes("\\") ||
        file.name === "." ||
        file.name === ".."
      ) {
        throw new Error("Invalid upload filename");
      }
      const relativePath = request.kind === "directory" ? file.relativePath : file.name;
      if (
        !relativePath ||
        (request.kind === "directory" && relativePath.split("/").length < 2) ||
        (request.kind === "file" && file.relativePath)
      ) {
        throw new Error("Upload does not match the field’s file/directory mode");
      }
      return { relativePath, data: file.data };
    });
    const saved = await createWorkspaceUploadBatch({
      rootDir: params.workspaceDir,
      files,
      assertCurrent,
    });
    if (request.kind === "file") {
      return saved.paths.map((filePath, index) => ({
        uri: pathToFileURL(filePath).href,
        name: request.files[index]!.name,
      }));
    }
    return [...new Set(files.map((file) => file.relativePath.split("/")[0]!))].map((name) => ({
      uri: pathToFileURL(path.join(saved.rootDir, name)).href,
      name,
    }));
  };
}
