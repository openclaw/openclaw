import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionEntry, SessionHeader } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { resolveTrajectoryFilePath } from "./runtime.js";
import type {
  TrajectoryBundleManifest,
  TrajectoryEvent,
  TrajectoryToolDefinition,
} from "./types.js";

type BuildTrajectoryBundleParams = {
  outputDir: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  runtimeFile?: string;
  systemPrompt?: string;
  tools?: TrajectoryToolDefinition[];
};

type RuntimeTrajectoryContext = {
  systemPrompt?: string;
  tools?: TrajectoryToolDefinition[];
};

type JsonRecord = Record<string, unknown>;

function parseJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  const rows = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed: T[] = [];
  for (const row of rows) {
    try {
      parsed.push(JSON.parse(row) as T);
    } catch {
      // Keep exports resilient even if a single debug line is malformed.
    }
  }
  return parsed;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(0).toISOString();
}

function resolveMessageEventType(message: AgentMessage): string {
  if (message.role === "user") {
    return "user.message";
  }
  if (message.role === "assistant") {
    return "assistant.message";
  }
  if (message.role === "toolResult") {
    return "tool.result";
  }
  return `message.${message.role}`;
}

function extractAssistantToolCalls(
  message: AgentMessage,
): Array<{ id?: string; name?: string; arguments?: unknown; index: number }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block, index) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const typedBlock = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
      input?: unknown;
      parameters?: unknown;
    };
    const blockType =
      typeof typedBlock.type === "string" ? typedBlock.type.trim().toLowerCase() : "";
    if (blockType !== "toolcall" && blockType !== "tooluse" && blockType !== "functioncall") {
      return [];
    }
    return [
      {
        id: typeof typedBlock.id === "string" ? typedBlock.id : undefined,
        name: typeof typedBlock.name === "string" ? typedBlock.name : undefined,
        arguments: typedBlock.arguments ?? typedBlock.input ?? typedBlock.parameters,
        index,
      },
    ];
  });
}

function buildTranscriptEvents(params: {
  entries: SessionEntry[];
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  traceId: string;
}): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  let seq = 0;
  for (const entry of params.entries) {
    const push = (type: string, data?: Record<string, unknown>) => {
      events.push({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: params.traceId,
        source: "transcript",
        type,
        ts: normalizeTimestamp(entry.timestamp),
        seq: 0,
        sourceSeq: (seq += 1),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        entryId: entry.id,
        parentEntryId: entry.parentId,
        data,
      });
    };

    switch (entry.type) {
      case "message": {
        push(resolveMessageEventType(entry.message), {
          message: sanitizeDiagnosticPayload(entry.message),
        });
        for (const toolCall of extractAssistantToolCalls(entry.message)) {
          push("tool.call", {
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: sanitizeDiagnosticPayload(toolCall.arguments),
            assistantEntryId: entry.id,
            blockIndex: toolCall.index,
          });
        }
        break;
      }
      case "compaction":
        push("session.compaction", {
          summary: entry.summary,
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          details: sanitizeDiagnosticPayload(entry.details),
          fromHook: entry.fromHook ?? false,
        });
        break;
      case "branch_summary":
        push("session.branch_summary", {
          fromId: entry.fromId,
          summary: entry.summary,
          details: sanitizeDiagnosticPayload(entry.details),
          fromHook: entry.fromHook ?? false,
        });
        break;
      case "custom":
        push("session.custom", {
          customType: entry.customType,
          data: sanitizeDiagnosticPayload(entry.data),
        });
        break;
      case "custom_message":
        push("session.custom_message", {
          customType: entry.customType,
          content: sanitizeDiagnosticPayload(entry.content),
          details: sanitizeDiagnosticPayload(entry.details),
          display: entry.display,
        });
        break;
      case "thinking_level_change":
        push("session.thinking_level_change", {
          thinkingLevel: entry.thinkingLevel,
        });
        break;
      case "model_change":
        push("session.model_change", {
          provider: entry.provider,
          modelId: entry.modelId,
        });
        break;
      case "label":
        push("session.label", {
          targetId: entry.targetId,
          label: entry.label,
        });
        break;
      case "session_info":
        push("session.info", {
          name: entry.name,
        });
        break;
    }
  }
  return events;
}

function sortTrajectoryEvents(events: TrajectoryEvent[]): TrajectoryEvent[] {
  const sourceOrder: Record<TrajectoryEvent["source"], number> = {
    runtime: 0,
    transcript: 1,
    export: 2,
  };
  const sorted = events.toSorted((left, right) => {
    const byTs = left.ts.localeCompare(right.ts);
    if (byTs !== 0) {
      return byTs;
    }
    const bySource = sourceOrder[left.source] - sourceOrder[right.source];
    if (bySource !== 0) {
      return bySource;
    }
    return (left.sourceSeq ?? left.seq) - (right.sourceSeq ?? right.seq);
  });
  for (const [index, event] of sorted.entries()) {
    event.seq = index + 1;
  }
  return sorted;
}

function prepareOutputDir(outputDir: string): void {
  fs.mkdirSync(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputDir, { mode: 0o700 });
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function writeJsonlFile(filePath: string, events: TrajectoryEvent[]): void {
  const lines = events
    .map((event) => safeJsonStringify(event))
    .filter((line): line is string => Boolean(line));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function resolveRuntimeContext(
  runtimeEvents: TrajectoryEvent[],
  fallback: Pick<BuildTrajectoryBundleParams, "systemPrompt" | "tools">,
): RuntimeTrajectoryContext {
  const latestContext = runtimeEvents
    .slice()
    .toReversed()
    .find((event) => event.type === "context.compiled");
  const runtimeData = latestContext?.data;
  const toolsValue = Array.isArray(runtimeData?.tools)
    ? (runtimeData.tools as TrajectoryToolDefinition[])
    : fallback.tools;
  return {
    systemPrompt:
      typeof runtimeData?.systemPrompt === "string"
        ? runtimeData.systemPrompt
        : fallback.systemPrompt,
    tools: toolsValue,
  };
}

function resolveLatestRuntimeEventData(
  runtimeEvents: TrajectoryEvent[],
  type: string,
): JsonRecord | undefined {
  const event = runtimeEvents
    .slice()
    .toReversed()
    .find((candidate) => candidate.type === type);
  return event?.data;
}

function normalizePathForMatch(value: string): string {
  return value.replaceAll("\\", "/").trim().toLowerCase();
}

function collectPotentialPathStrings(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (input: unknown) => {
    if (!input || typeof input !== "object") {
      return;
    }
    if (Array.isArray(input)) {
      for (const entry of input) {
        visit(entry);
      }
      return;
    }
    for (const [key, entry] of Object.entries(input)) {
      if (
        typeof entry === "string" &&
        (key.toLowerCase().includes("path") ||
          entry.endsWith("SKILL.md") ||
          entry.endsWith("skill.md"))
      ) {
        found.add(entry);
      } else {
        visit(entry);
      }
    }
  };
  visit(value);
  return [...found];
}

function markInvokedSkills(params: { skills: unknown; events: TrajectoryEvent[] }): unknown {
  if (!params.skills || typeof params.skills !== "object") {
    return params.skills;
  }
  const skillsRecord = params.skills as {
    entries?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(skillsRecord.entries) || skillsRecord.entries.length === 0) {
    return params.skills;
  }
  const invokedPaths = new Set(
    params.events.flatMap((event) => {
      if (event.type !== "tool.call") {
        return [];
      }
      return collectPotentialPathStrings(event.data?.arguments);
    }),
  );
  const normalizedInvokedPaths = new Set(
    [...invokedPaths].map((value) => normalizePathForMatch(value)),
  );
  const entries = skillsRecord.entries.map((entry) => {
    const rawPath = typeof entry.filePath === "string" ? entry.filePath : undefined;
    const normalizedPath = rawPath ? normalizePathForMatch(rawPath) : undefined;
    const skillDirName =
      rawPath?.replaceAll("\\", "/").split("/").slice(-2, -1)[0]?.toLowerCase() ?? undefined;
    const invoked = normalizedPath
      ? [...normalizedInvokedPaths].some(
          (candidate) =>
            candidate === normalizedPath ||
            candidate.endsWith(normalizedPath) ||
            (skillDirName ? candidate.endsWith(`/${skillDirName}/skill.md`) : false),
        )
      : false;
    return invoked
      ? {
          ...entry,
          invoked,
          invocationDetectedBy: "tool-call-file-path",
        }
      : {
          ...entry,
          invoked: false,
        };
  });
  return {
    ...skillsRecord,
    entries,
  };
}

function buildMetadataCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
  events: TrajectoryEvent[];
}): JsonRecord | undefined {
  const runtimeMetadata = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.metadata");
  if (!runtimeMetadata) {
    return undefined;
  }
  const modelFallback = (() => {
    const latest = params.runtimeEvents
      .slice()
      .toReversed()
      .find((event) => event.provider || event.modelId || event.modelApi);
    if (!latest?.provider && !latest?.modelId && !latest?.modelApi) {
      return undefined;
    }
    return {
      provider: latest.provider,
      name: latest.modelId,
      api: latest.modelApi,
    };
  })();
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    harness: runtimeMetadata.harness,
    model: runtimeMetadata.model ?? modelFallback,
    config: runtimeMetadata.config,
    plugins: runtimeMetadata.plugins,
    skills: markInvokedSkills({
      skills: runtimeMetadata.skills,
      events: params.events,
    }),
    prompting: runtimeMetadata.prompting,
    redaction: runtimeMetadata.redaction,
    metadata: runtimeMetadata.metadata,
  };
}

function buildArtifactsCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
}): JsonRecord | undefined {
  const runtimeArtifacts = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.artifacts");
  const runtimeCompletion = resolveLatestRuntimeEventData(params.runtimeEvents, "model.completed");
  const runtimeEnd = resolveLatestRuntimeEventData(params.runtimeEvents, "session.ended");
  if (!runtimeArtifacts && !runtimeCompletion && !runtimeEnd) {
    return undefined;
  }
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    finalStatus: runtimeArtifacts?.finalStatus ?? runtimeEnd?.status,
    aborted: runtimeArtifacts?.aborted ?? runtimeEnd?.aborted,
    externalAbort: runtimeArtifacts?.externalAbort ?? runtimeEnd?.externalAbort,
    timedOut: runtimeArtifacts?.timedOut ?? runtimeEnd?.timedOut,
    idleTimedOut: runtimeArtifacts?.idleTimedOut ?? runtimeEnd?.idleTimedOut,
    timedOutDuringCompaction:
      runtimeArtifacts?.timedOutDuringCompaction ?? runtimeEnd?.timedOutDuringCompaction,
    promptError:
      runtimeArtifacts?.promptError ?? runtimeEnd?.promptError ?? runtimeCompletion?.promptError,
    promptErrorSource: runtimeArtifacts?.promptErrorSource ?? runtimeCompletion?.promptErrorSource,
    usage: runtimeArtifacts?.usage ?? runtimeCompletion?.usage,
    promptCache: runtimeArtifacts?.promptCache ?? runtimeCompletion?.promptCache,
    compactionCount: runtimeArtifacts?.compactionCount ?? runtimeCompletion?.compactionCount,
    assistantTexts: runtimeArtifacts?.assistantTexts ?? runtimeCompletion?.assistantTexts,
    finalPromptText: runtimeArtifacts?.finalPromptText ?? runtimeCompletion?.finalPromptText,
    itemLifecycle: runtimeArtifacts?.itemLifecycle,
    toolMetas: runtimeArtifacts?.toolMetas,
    didSendViaMessagingTool: runtimeArtifacts?.didSendViaMessagingTool,
    successfulCronAdds: runtimeArtifacts?.successfulCronAdds,
    messagingToolSentTexts: runtimeArtifacts?.messagingToolSentTexts,
    messagingToolSentMediaUrls: runtimeArtifacts?.messagingToolSentMediaUrls,
    messagingToolSentTargets: runtimeArtifacts?.messagingToolSentTargets,
    lastToolError: runtimeArtifacts?.lastToolError,
  };
}

function buildPromptsCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
  runtimeContext: RuntimeTrajectoryContext;
}): JsonRecord | undefined {
  const runtimeMetadata = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.metadata");
  const latestCompiled = resolveLatestRuntimeEventData(params.runtimeEvents, "context.compiled");
  const submittedPrompts = params.runtimeEvents
    .filter((event) => event.type === "prompt.submitted")
    .map((event) => event.data?.prompt)
    .filter((prompt): prompt is string => typeof prompt === "string");
  const systemPrompt =
    (typeof latestCompiled?.systemPrompt === "string" ? latestCompiled.systemPrompt : undefined) ??
    params.runtimeContext.systemPrompt;
  const skillsPrompt =
    runtimeMetadata?.prompting &&
    typeof runtimeMetadata.prompting === "object" &&
    typeof (runtimeMetadata.prompting as JsonRecord).skillsPrompt === "string"
      ? ((runtimeMetadata.prompting as JsonRecord).skillsPrompt as string)
      : undefined;
  const userPromptPrefixText =
    runtimeMetadata?.prompting &&
    typeof runtimeMetadata.prompting === "object" &&
    typeof (runtimeMetadata.prompting as JsonRecord).userPromptPrefixText === "string"
      ? ((runtimeMetadata.prompting as JsonRecord).userPromptPrefixText as string)
      : undefined;
  const promptReport =
    runtimeMetadata?.prompting &&
    typeof runtimeMetadata.prompting === "object" &&
    typeof (runtimeMetadata.prompting as JsonRecord).systemPromptReport === "object"
      ? (runtimeMetadata.prompting as JsonRecord).systemPromptReport
      : undefined;
  if (!systemPrompt && submittedPrompts.length === 0 && !skillsPrompt && !userPromptPrefixText) {
    return undefined;
  }
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    system: systemPrompt,
    submittedPrompts,
    latestSubmittedPrompt: submittedPrompts.at(-1),
    skillsPrompt,
    userPromptPrefixText,
    systemPromptReport: promptReport,
  };
}

export function resolveDefaultTrajectoryExportDir(params: {
  workspaceDir: string;
  sessionId: string;
  now?: Date;
}): string {
  const timestamp = (params.now ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(
    params.workspaceDir,
    `openclaw-trajectory-${params.sessionId.slice(0, 8)}-${timestamp}`,
  );
}

export function exportTrajectoryBundle(params: BuildTrajectoryBundleParams): {
  manifest: TrajectoryBundleManifest;
  outputDir: string;
  events: TrajectoryEvent[];
  header: SessionHeader | null;
  runtimeFile?: string;
  supplementalFiles: string[];
} {
  prepareOutputDir(params.outputDir);

  const sessionManager = SessionManager.open(params.sessionFile);
  const header = sessionManager.getHeader();
  const leafId = sessionManager.getLeafId();
  const branchEntries = sessionManager.getBranch(leafId ?? undefined);
  const runtimeFile =
    params.runtimeFile ??
    resolveTrajectoryFilePath({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
    });
  const runtimeEvents = parseJsonlFile<TrajectoryEvent>(runtimeFile);
  const transcriptEvents = buildTranscriptEvents({
    entries: branchEntries,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    traceId: params.sessionId,
  });
  const events = sortTrajectoryEvents([...runtimeEvents, ...transcriptEvents]);
  const manifest: TrajectoryBundleManifest = {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.sessionId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    leafId,
    eventCount: events.length,
    runtimeEventCount: runtimeEvents.length,
    transcriptEventCount: transcriptEvents.length,
    sourceFiles: {
      session: params.sessionFile,
      runtime: fs.existsSync(runtimeFile) ? runtimeFile : undefined,
    },
  };

  const bundleRuntimeContext = resolveRuntimeContext(runtimeEvents, {
    systemPrompt: params.systemPrompt,
    tools: params.tools,
  });
  const supplementalFiles: string[] = [];
  const metadataCapture = buildMetadataCapture({
    manifest,
    runtimeEvents,
    events,
  });
  const artifactsCapture = buildArtifactsCapture({
    manifest,
    runtimeEvents,
  });
  const promptsCapture = buildPromptsCapture({
    manifest,
    runtimeEvents,
    runtimeContext: bundleRuntimeContext,
  });
  if (metadataCapture) {
    writeJsonFile(path.join(params.outputDir, "metadata.json"), metadataCapture);
    supplementalFiles.push("metadata.json");
  }
  if (artifactsCapture) {
    writeJsonFile(path.join(params.outputDir, "artifacts.json"), artifactsCapture);
    supplementalFiles.push("artifacts.json");
  }
  if (promptsCapture) {
    writeJsonFile(path.join(params.outputDir, "prompts.json"), promptsCapture);
    supplementalFiles.push("prompts.json");
  }
  if (supplementalFiles.length > 0) {
    manifest.supplementalFiles = supplementalFiles;
  }

  writeJsonFile(path.join(params.outputDir, "manifest.json"), manifest);
  writeJsonlFile(path.join(params.outputDir, "events.jsonl"), events);
  writeJsonFile(
    path.join(params.outputDir, "session-branch.json"),
    sanitizeDiagnosticPayload({
      header,
      leafId,
      entries: branchEntries,
    }),
  );
  fs.copyFileSync(
    params.sessionFile,
    path.join(params.outputDir, "session.jsonl"),
    fs.constants.COPYFILE_EXCL,
  );
  if (fs.existsSync(runtimeFile)) {
    fs.copyFileSync(
      runtimeFile,
      path.join(params.outputDir, "runtime.jsonl"),
      fs.constants.COPYFILE_EXCL,
    );
  }
  if (bundleRuntimeContext.systemPrompt) {
    fs.writeFileSync(
      path.join(params.outputDir, "system-prompt.txt"),
      bundleRuntimeContext.systemPrompt,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  if (bundleRuntimeContext.tools) {
    writeJsonFile(path.join(params.outputDir, "tools.json"), bundleRuntimeContext.tools);
  }

  return {
    manifest,
    outputDir: params.outputDir,
    events,
    header,
    runtimeFile: fs.existsSync(runtimeFile) ? runtimeFile : undefined,
    supplementalFiles,
  };
}
