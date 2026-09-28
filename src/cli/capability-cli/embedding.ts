import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { collectOption } from "../program/helpers.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { formatEnvelopeForText, providerSummaryText } from "./output.js";
import { registerLocalProvidersCommand, runCapabilityCommand } from "./providers-command.js";

async function closeEmbeddingProviderWithRetry(provider: {
  close?: () => Promise<void> | void;
}): Promise<void> {
  try {
    await provider.close?.();
  } catch {
    await provider.close?.();
  }
}

async function runMemoryEmbeddingCreate(params: {
  texts: string[];
  provider?: string;
  model?: string;
  agent?: string;
}) {
  const {
    requireProviderModelOverride,
    resolveCapabilityProviderAgentId,
    resolveLocalCapabilityRuntimeConfig,
  } = await import("./shared.js");
  const { getMemoryEmbeddingCommandSecretTargetIds } = await import("../command-secret-targets.js");
  const { resolveAgentDir } = await import("../../agents/agent-scope.js");
  const { createEmbeddingProvider } =
    await import("../../plugin-sdk/memory-core-bundled-runtime.js");
  const modelRef = requireProviderModelOverride(params.model);
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer embedding create",
    targetIds: getMemoryEmbeddingCommandSecretTargetIds(),
  });
  const requestedProvider =
    normalizeOptionalString(params.provider) || modelRef?.provider || "auto";
  const agentId = resolveCapabilityProviderAgentId(cfg, params.agent, "infer embedding create");
  const { prepareLocalCapabilityAccountSecrets } = await import("./local-account-secrets.js");
  await prepareLocalCapabilityAccountSecrets({ cfg, agentId });
  const result = await createEmbeddingProvider({
    config: cfg,
    agentDir: resolveAgentDir(cfg, agentId),
    provider: requestedProvider,
    fallback: "none",
    model: modelRef?.model ?? "",
  });
  if (!result.provider) {
    throw new Error(result.providerUnavailableReason ?? "No embedding provider available.");
  }
  const provider = result.provider;
  let embeddings: number[][];
  try {
    embeddings = await provider.embedBatch(params.texts, { inputType: "document" });
  } catch (err) {
    // Cleanup failure must not replace the embedding error.
    await closeEmbeddingProviderWithRetry(provider).catch(() => {});
    throw err;
  }
  await closeEmbeddingProviderWithRetry(provider);
  return {
    ok: true,
    capability: "embedding.create",
    transport: "local" as const,
    provider: provider.id,
    model: provider.model,
    attempts: result.fallbackFrom
      ? [{ provider: result.fallbackFrom, outcome: "failed", error: result.fallbackReason }]
      : [],
    outputs: embeddings.map((embedding, index) => ({
      text: params.texts[index],
      embedding,
      dimensions: embedding.length,
    })),
  } satisfies CapabilityEnvelope;
}

export function registerEmbeddingCapabilityCommands(capability: Command): void {
  const embedding = capability
    .command("embedding")
    .description("Embedding providers")
    .option("--agent <id>", "Agent whose model and auth state should be used");

  embedding
    .command("create")
    .description("Create embeddings")
    .requiredOption("--text <text>", "Input text", collectOption)
    .option("--provider <id>", "Provider id")
    .option("--model <provider/model>", "Model override")
    .option(
      "--agent <id>",
      "Agent whose saved provider auth is used (default: agents.defaults.systemAgent.agentId, then the sole agent)",
    )
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, formatEnvelopeForText, async () => {
        const { resolveCapabilityAgentOption } = await import("./shared.js");
        return runMemoryEmbeddingCreate({
          texts: opts.text as string[],
          agent: resolveCapabilityAgentOption(command, opts.agent),
          provider: opts.provider as string | undefined,
          model: opts.model as string | undefined,
        });
      }),
    );

  registerLocalProvidersCommand(
    embedding,
    "List embedding providers",
    async (cfg, agentId) => {
      const { providerHasGenericConfig } = await import("./shared.js");
      const { resolveMemorySearchConfig } = await import("../../agents/memory-search.js");
      const { listEmbeddingProviders } =
        await import("../../plugins/embedding-provider-runtime.js");
      const { listRegisteredMemoryEmbeddingProviderAdapters } =
        await import("../../plugins/memory-embedding-provider-runtime.js");
      const resolvedMemory = resolveMemorySearchConfig(cfg, agentId);
      const selectedProvider = resolvedMemory?.provider;
      const providers = new Map(
        listRegisteredMemoryEmbeddingProviderAdapters().map((provider) => [
          provider.id,
          {
            id: provider.id,
            defaultModel: provider.defaultModel,
            transport: provider.transport,
            autoSelectPriority: provider.autoSelectPriority,
          },
        ]),
      );
      for (const provider of listEmbeddingProviders(cfg)) {
        if (providers.has(provider.id)) {
          continue;
        }
        providers.set(provider.id, {
          id: provider.id,
          defaultModel: provider.defaultModel,
          transport: provider.transport,
          autoSelectPriority: undefined,
        });
      }
      if (selectedProvider && !providers.has(selectedProvider)) {
        providers.set(selectedProvider, {
          id: selectedProvider,
          defaultModel: resolvedMemory?.model || undefined,
          transport: providerHasGenericConfig({ cfg, providerId: selectedProvider, agentId })
            ? "remote"
            : undefined,
          autoSelectPriority: undefined,
        });
      }
      return Array.from(providers.values()).map((provider) => ({
        available: true,
        configured:
          provider.id === selectedProvider ||
          providerHasGenericConfig({
            cfg,
            providerId: provider.id,
            agentId,
          }),
        selected: provider.id === selectedProvider,
        id: provider.id,
        defaultModel: provider.defaultModel,
        transport: provider.transport,
        autoSelectPriority: provider.autoSelectPriority,
      }));
    },
    providerSummaryText,
  );
}
