import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  hasOnlyAssistantReasoningContent,
  isReasoningOnlyLengthAssistantTurn,
} from "@openclaw/ai/internal/shared";
import { detectMime, normalizeMimeType } from "@openclaw/media-core/mime";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  normalizeThinkLevel,
  THINKING_LEVELS_HELP,
  type ThinkLevel,
} from "../../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ADMIN_SCOPE } from "../../gateway/operator-scopes.js";
import { defaultRuntime } from "../../runtime.js";
import { AsyncWorkScope, captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { collectOption } from "../program/helpers.js";
import type { CapabilityEnvelope, CapabilityTransport } from "./metadata.js";
import { formatEnvelopeForText, providerSummaryText } from "./output.js";
import { registerLocalProvidersCommand, runCapabilityCommand } from "./providers-command.js";

const LOCAL_MODEL_RUN_SYSTEM_PROMPT = "You are a personal assistant running inside OpenClaw.";
const HEIC_MODEL_RUN_MIMES = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
]);

async function loadModelCatalogForInspection(cfg: OpenClawConfig, rawAgentId?: string) {
  const { resolveCapabilityProviderAgentId } = await import("./shared.js");
  const { readPreparedModelCatalog } = await import("../../agents/prepared-model-catalog.js");
  const agentId =
    rawAgentId === undefined ? undefined : resolveCapabilityProviderAgentId(cfg, rawAgentId);
  const prepared = await readPreparedModelCatalog({ config: cfg, agentId, readOnly: true });
  return prepared.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
}

function collectModelRunText(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

function requireModelRunPrompt(value: unknown): string {
  if (typeof value !== "string" || normalizeOptionalString(value) === undefined) {
    throw new Error("--prompt cannot be empty or whitespace-only.");
  }
  return value;
}

type ModelRunImageFile = {
  path: string;
  fileName: string;
  mimeType: string;
  data: string;
};

async function readModelRunImageFiles(files: string[] | undefined): Promise<ModelRunImageFile[]> {
  if (!files || files.length === 0) {
    return [];
  }
  return await Promise.all(
    files.map(async (filePath) => {
      const resolvedPath = path.resolve(filePath);
      const buffer = await fs.readFile(resolvedPath);
      const mimeType = normalizeMimeType(
        await detectMime({
          buffer,
          filePath: resolvedPath,
        }),
      );
      if (!mimeType?.startsWith("image/")) {
        throw new Error(
          `Unsupported --file for model run: ${resolvedPath}. Only image files are supported; use infer audio transcribe for audio files.`,
        );
      }
      const isHeic = HEIC_MODEL_RUN_MIMES.has(mimeType);
      const imageBuffer = isHeic
        ? await (await import("../../media/media-services.js")).convertHeicToJpeg(buffer)
        : buffer;
      return {
        path: resolvedPath,
        fileName: path.basename(resolvedPath),
        mimeType: isHeic ? "image/jpeg" : mimeType,
        data: imageBuffer.toString("base64"),
      };
    }),
  );
}

function normalizeModelRunThinking(value: unknown): ThinkLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("--thinking must be a string.");
  }
  const normalized = normalizeThinkLevel(value);
  if (!normalized) {
    throw new Error(`Invalid thinking level. Use one of: ${THINKING_LEVELS_HELP}.`);
  }
  return normalized;
}

async function runModelRun(params: {
  prompt: string;
  files?: string[];
  model?: string;
  thinking?: ThinkLevel;
  transport: CapabilityTransport;
  agent?: string;
}) {
  const {
    requireProviderModelOverride,
    resolveCapabilityProviderAgentId,
    resolveLocalCapabilityRuntimeConfig,
  } = await import("./shared.js");
  const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
  const { getRuntimeConfig } = await import("../../config/config.js");
  const { canonicalizeCaseOnlyCatalogModelRef } = await import("../../agents/model-selection.js");
  const { readPreparedModelCatalog } = await import("../../agents/prepared-model-catalog.js");
  const explicitModelOverride = requireProviderModelOverride(params.model);
  const cfg =
    params.transport === "local"
      ? await resolveLocalCapabilityRuntimeConfig({
          commandName: "infer model run",
          targetIds: getModelsCommandSecretTargetIds(),
        })
      : getRuntimeConfig();
  const agentId = resolveCapabilityProviderAgentId(cfg, params.agent, "infer model run");
  const modelRef = await canonicalizeCaseOnlyCatalogModelRef({
    raw: params.model,
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    loadCatalog: () => readPreparedModelCatalog({ config: cfg, agentId, readOnly: true }),
    preserveAuthProfile: params.transport === "local",
  });
  const hasExplicitProviderModelOverride = Boolean(explicitModelOverride);
  const imageFiles = await readModelRunImageFiles(params.files);
  const messageContent =
    imageFiles.length > 0
      ? [
          { type: "text" as const, text: params.prompt },
          ...imageFiles.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ]
      : params.prompt;
  if (params.transport === "local") {
    const { acquireSimpleCompletionModelForAgent, completeWithPreparedSimpleCompletionModel } =
      await import("../../agents/simple-completion-runtime.js");
    const callerResult = createDeferredCore<CapabilityEnvelope>();
    const trackOwner = captureAsyncWorkTracker();
    // Command completion can precede response callbacks and cancellation drainage.
    void trackOwner(async () => {
      const { prepareLocalCapabilityAccountSecrets } = await import("./local-account-secrets.js");
      await prepareLocalCapabilityAccountSecrets({ cfg, agentId });
      const prepared = await acquireSimpleCompletionModelForAgent({
        cfg,
        agentId,
        modelRef,
        allowMissingApiKeyModes: ["aws-sdk"],
        ...(hasExplicitProviderModelOverride ? { allowBundledStaticCatalogFallback: true } : {}),
        skipAgentDiscovery: true,
      });
      if ("error" in prepared) {
        throw new Error(prepared.error);
      }
      const work = new AsyncWorkScope();
      try {
        callerResult.resolve(
          await work.track(async () => {
            if (prepared.selection.provider === "codex") {
              throw new Error(
                'The codex provider is served by the Codex app-server agent runtime, not the local simple-completion transport. Use an openai/<model> ref with provider/model agentRuntime.id: "codex", run through the gateway, or use /codex commands.',
              );
            }
            const localModelRunSystemPrompt =
              prepared.model.api === "openai-chatgpt-responses"
                ? LOCAL_MODEL_RUN_SYSTEM_PROMPT
                : undefined;
            const result = await completeWithPreparedSimpleCompletionModel({
              model: prepared.model,
              auth: prepared.auth,
              cfg,
              context: {
                ...(localModelRunSystemPrompt ? { systemPrompt: localModelRunSystemPrompt } : {}),
                messages: [
                  {
                    role: "user",
                    content: messageContent,
                    timestamp: Date.now(),
                  },
                ],
              },
              options: {
                maxTokens:
                  typeof prepared.model.maxTokens === "number" &&
                  Number.isFinite(prepared.model.maxTokens)
                    ? prepared.model.maxTokens
                    : undefined,
                ...(params.thinking ? { reasoning: params.thinking } : {}),
              },
            });
            const text = collectModelRunText(result.content);
            if (!text) {
              const providerErrorMessage = (result as { errorMessage?: unknown }).errorMessage;
              const detail =
                typeof providerErrorMessage === "string" && providerErrorMessage.trim()
                  ? `: ${providerErrorMessage.trim()}`
                  : "";
              const target = `for provider "${prepared.selection.provider}" model "${prepared.selection.modelId}"${detail}.`;
              // Failed or aborted streams can keep partial reasoning; report those as provider failures.
              const completedWithoutError =
                (result.stopReason === "stop" || result.stopReason === "length") && !detail;
              if (completedWithoutError && hasOnlyAssistantReasoningContent(result)) {
                const limitHint = isReasoningOnlyLengthAssistantTurn(result)
                  ? " It stopped at the output token limit while reasoning; a lower --thinking level may leave room for text."
                  : "";
                throw new Error(
                  `Model returned reasoning but no text output ${target}${limitHint}`,
                );
              }
              throw new Error(`No text output returned ${target}`);
            }
            return {
              ok: true,
              capability: "model.run",
              transport: "local" as const,
              provider: prepared.selection.provider,
              model: prepared.selection.modelId,
              attempts: [],
              ...(imageFiles.length > 0
                ? {
                    inputs: imageFiles.map((image) => ({
                      path: image.path,
                      mimeType: image.mimeType,
                    })),
                  }
                : {}),
              outputs: [
                {
                  text,
                  mediaUrl: null,
                },
              ],
            } satisfies CapabilityEnvelope;
          }),
        );
      } catch (error) {
        callerResult.reject(error);
      } finally {
        await work.drain();
        await prepared[Symbol.asyncDispose]();
      }
    }).catch((error: unknown) => callerResult.reject(error));
    return await callerResult.promise;
  }

  const { buildExplicitSessionIdSessionKey } = await import("../../agents/command/session.js");
  const { callGateway, randomIdempotencyKey } = await import("../../gateway/call.js");
  const { provider, model } = requireProviderModelOverride(modelRef) ?? {};
  // Provider/model overrides require trusted-operator scope. Use the backend
  // shared-secret lane so local gateway smokes do not depend on paired CLI device scopes.
  const hasModelOverride = Boolean(provider || model);
  const sessionId = `model-run-${randomUUID()}`;
  const sessionKey = buildExplicitSessionIdSessionKey({ agentId, sessionId });
  const response: {
    result?: {
      payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
      meta?: {
        agentMeta?: {
          provider?: string;
          model?: string;
          fallbackAttempts?: Array<Record<string, unknown>>;
        };
      };
    };
  } = await callGateway({
    method: "agent",
    params: {
      agentId,
      sessionId,
      sessionKey,
      message: params.prompt,
      attachments:
        imageFiles.length > 0
          ? imageFiles.map((image) => ({
              type: "image",
              fileName: image.fileName,
              mimeType: image.mimeType,
              content: image.data,
            }))
          : undefined,
      provider,
      model,
      ...(params.thinking ? { thinking: params.thinking } : {}),
      modelRun: true,
      promptMode: "none",
      cleanupBundleMcpOnRunEnd: true,
      idempotencyKey: randomIdempotencyKey(),
    },
    expectFinal: true,
    timeoutMs: 120_000,
    clientName: hasModelOverride ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
    mode: hasModelOverride ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
    ...(hasModelOverride ? { scopes: [ADMIN_SCOPE] } : {}),
  });
  return {
    ok: true,
    capability: "model.run",
    transport: "gateway" as const,
    provider: response?.result?.meta?.agentMeta?.provider,
    model: response?.result?.meta?.agentMeta?.model,
    attempts: response?.result?.meta?.agentMeta?.fallbackAttempts ?? [],
    outputs: (response?.result?.payloads ?? []).map((payload) => ({
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
    })),
    ...(imageFiles.length > 0
      ? {
          inputs: imageFiles.map((image) => ({
            path: image.path,
            mimeType: image.mimeType,
          })),
        }
      : {}),
  } satisfies CapabilityEnvelope;
}

async function buildModelProviders(cfg: OpenClawConfig, agentId: string) {
  const { providerHasGenericConfig, resolveSelectedProviderFromModelRef } =
    await import("./shared.js");
  const { resolveAgentEffectiveModelPrimary } = await import("../../agents/agent-scope.js");
  const { getProviderEnvVarsCore } = await import("../../secrets/provider-env-vars.js");
  const catalog = await loadModelCatalogForInspection(cfg, agentId);
  const selectedProvider = resolveSelectedProviderFromModelRef(
    resolveAgentEffectiveModelPrimary(cfg, agentId),
  );
  const grouped = new Map<
    string,
    {
      provider: string;
      count: number;
      defaults: string[];
      available: boolean;
      configured: boolean;
      selected: boolean;
    }
  >();
  for (const entry of catalog) {
    const current = grouped.get(entry.provider) ?? {
      provider: entry.provider,
      count: 0,
      defaults: [],
      available: true,
      configured: providerHasGenericConfig({
        cfg,
        providerId: entry.provider,
        agentId,
        envVars: getProviderEnvVarsCore(entry.provider),
      }),
      selected: selectedProvider === entry.provider,
    };
    current.count += 1;
    if (current.defaults.length < 3) {
      current.defaults.push(entry.id);
    }
    grouped.set(entry.provider, current);
  }
  return [...grouped.values()].toSorted((a, b) => a.provider.localeCompare(b.provider));
}

async function runModelAuthStatus(agent: string) {
  const captured: string[] = [];
  const { modelsStatusCommand } = await import("../../commands/models/list.status-command.js");
  await modelsStatusCommand(
    { json: true, agent },
    {
      log: (...args) => captured.push(args.join(" ")),
      error: (message) => {
        throw message instanceof Error ? message : new Error(String(message));
      },
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  );
  const raw = captured.find((line) => line.trim().startsWith("{"));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function runModelAuthLogout(provider: string, agent: string) {
  const { getRuntimeConfig } = await import("../../config/config.js");
  const { resolveAgentDir } = await import("../../agents/agent-scope.js");
  const { listProfilesForProvider, loadAuthProfileStoreForRuntime } =
    await import("../../agents/auth-profiles.js");
  const { updateAuthProfileStoreWithLock } =
    await import("../../agents/auth-profiles/store-runtime.js");
  const cfg = getRuntimeConfig();
  const agentDir = resolveAgentDir(cfg, agent);
  const store = loadAuthProfileStoreForRuntime(agentDir);
  const profileIds = listProfilesForProvider(store, provider);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (nextStore) => {
      let changed = false;
      for (const profileId of profileIds) {
        if (nextStore.profiles[profileId]) {
          delete nextStore.profiles[profileId];
          changed = true;
        }
        if (nextStore.usageStats?.[profileId]) {
          delete nextStore.usageStats[profileId];
          changed = true;
        }
      }
      if (nextStore.order?.[provider]) {
        delete nextStore.order[provider];
        changed = true;
      }
      if (nextStore.lastGood?.[provider]) {
        delete nextStore.lastGood[provider];
        changed = true;
      }
      return changed;
    },
  });
  if (!updated) {
    throw new Error(`Failed to remove saved auth profiles for provider ${provider}.`);
  }
  return {
    provider,
    removedProfiles: profileIds,
  };
}

export function registerModelCapabilityCommands(capability: Command): void {
  const model = capability
    .command("model")
    .description("Text inference and model catalog commands")
    .option("--agent <id>", "Agent whose model and auth state should be used");

  model
    .command("run")
    .description("Run a one-shot model turn")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--file <path>", "Image file", collectOption, [])
    .option("--model <provider/model>", "Model override")
    .option("--thinking <level>", "Thinking level override")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option(
      "--agent <id>",
      "Agent whose model and credentials own the run (default: agents.defaults.systemAgent.agentId, then the sole agent)",
    )
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, formatEnvelopeForText, async () => {
        const { resolveCapabilityAgentOption, resolveTransport } = await import("./shared.js");
        const prompt = requireModelRunPrompt(opts.prompt);
        const thinking = normalizeModelRunThinking(opts.thinking);
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "local",
        });
        return runModelRun({
          prompt,
          agent: resolveCapabilityAgentOption(command, opts.agent),
          files: opts.file as string[] | undefined,
          model: opts.model as string | undefined,
          thinking,
          transport,
        });
      }),
    );

  model
    .command("list")
    .description("List known models")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, providerSummaryText, async () => {
        const { resolveCapabilityAgentOption } = await import("./shared.js");
        const { getRuntimeConfig } = await import("../../config/config.js");
        return loadModelCatalogForInspection(
          getRuntimeConfig(),
          resolveCapabilityAgentOption(command, opts.agent),
        );
      }),
    );

  model
    .command("inspect")
    .description("Inspect one model catalog entry")
    .requiredOption("--model <provider/model>", "Model id")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, undefined, async () => {
        const { resolveCapabilityAgentOption } = await import("./shared.js");
        const { getRuntimeConfig } = await import("../../config/config.js");
        const target = normalizeStringifiedOptionalString(opts.model) ?? "";
        const catalog = await loadModelCatalogForInspection(
          getRuntimeConfig(),
          resolveCapabilityAgentOption(command, opts.agent),
        );
        const entry =
          catalog.find((candidate) => `${candidate.provider}/${candidate.id}` === target) ??
          catalog.find((candidate) => candidate.id === target);
        if (!entry) {
          throw new Error(`Model not found: ${target}`);
        }
        return entry;
      }),
    );

  registerLocalProvidersCommand(
    model,
    "List model providers from the catalog",
    buildModelProviders,
    providerSummaryText,
  );

  const modelAuth = model
    .command("auth")
    .description("Provider auth helpers")
    .option("--agent <id>", "Agent id (default: configured default agent)");

  const resolveModelAuthAgent = async (command: Command, rawAgentId: unknown, surface: string) => {
    const { resolveCapabilityProviderAgentId, resolveCapabilityAgentOption } =
      await import("./shared.js");
    const { getRuntimeConfig } = await import("../../config/config.js");
    return resolveCapabilityProviderAgentId(
      getRuntimeConfig(),
      resolveCapabilityAgentOption(command, rawAgentId),
      surface,
    );
  };

  modelAuth
    .command("login")
    .description("Run provider auth login")
    .requiredOption("--provider <id>", "Provider id")
    .option("--method <id>", "Provider auth method id")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const agent = await resolveModelAuthAgent(command, opts.agent, "infer model auth login");
        const { modelsAuthLoginCommand } = await import("../../commands/models/auth.js");
        await modelsAuthLoginCommand(
          {
            provider: String(opts.provider),
            method: opts.method ? String(opts.method) : undefined,
            agent,
          },
          defaultRuntime,
        );
      });
    });

  modelAuth
    .command("logout")
    .description("Remove saved auth profiles for one provider")
    .requiredOption("--provider <id>", "Provider id")
    .option(
      "--agent <id>",
      "Agent id (default: agents.defaults.systemAgent.agentId, then the sole agent)",
    )
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, undefined, async () => {
        return runModelAuthLogout(
          String(opts.provider),
          await resolveModelAuthAgent(command, opts.agent, "infer model auth logout"),
        );
      }),
    );

  modelAuth
    .command("status")
    .description("Show configured auth state")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, undefined, async () => {
        return runModelAuthStatus(
          await resolveModelAuthAgent(command, opts.agent, "infer model auth status"),
        );
      }),
    );
}
