import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { emitJsonOrText, formatEnvelopeForText } from "./output.js";
import { registerLocalProvidersCommand } from "./providers-command.js";

function describeWebResultFailure(result: Record<string, unknown>): string | undefined {
  const statusCode =
    typeof result.statusCode === "number" && Number.isFinite(result.statusCode)
      ? result.statusCode
      : undefined;
  const error = result.error;
  const errorMessage =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : undefined;
  if (result.ok !== false && (statusCode === undefined || statusCode < 400) && !errorMessage) {
    return undefined;
  }
  return (
    errorMessage ??
    (statusCode ? `provider returned status ${statusCode}` : "provider reported failure")
  );
}

function runWebCommand(
  capability: "web.search" | "web.fetch",
  json: boolean | undefined,
  run: () => Promise<{ provider: string; result: Record<string, unknown> }>,
): Promise<void> {
  return runCommandWithRuntime(defaultRuntime, async () => {
    const { provider, result } = await run();
    const error = describeWebResultFailure(result);
    const envelope = {
      ok: error === undefined,
      capability,
      transport: "local" as const,
      provider,
      attempts: [],
      outputs: [{ result }],
      ...(error ? { error } : {}),
    } satisfies CapabilityEnvelope;
    emitJsonOrText(defaultRuntime, Boolean(json), envelope, formatEnvelopeForText);
    if (!envelope.ok) {
      exitCliAfterOutput(defaultRuntime, 1);
    }
  });
}

export function registerWebCapabilityCommands(capability: Command): void {
  const web = capability.command("web").description("Web capabilities");

  web
    .command("search")
    .description("Run web search")
    .requiredOption("--query <text>", "Search query")
    .option("--provider <id>", "Provider id")
    .option("--limit <n>", "Result limit")
    .option("--json", "Output JSON", false)
    .action((opts) =>
      runWebCommand("web.search", opts.json, async () => {
        const { parseOptionalPositiveInteger } = await import("./shared.js");
        const query = String(opts.query);
        const provider = opts.provider as string | undefined;
        const limit = parseOptionalPositiveInteger(opts.limit, "--limit");
        const { getRuntimeConfig } = await import("../../config/config.js");
        const { getCapabilityWebSearchCommandSecretTargets } =
          await import("../command-secret-targets.js");
        const { resolveLocalCapabilityRuntimeConfig } = await import("./shared.js");
        const { runWebSearch } = await import("../../web-search/runtime.js");
        const rawConfig = getRuntimeConfig();
        const scopedTargets = getCapabilityWebSearchCommandSecretTargets(rawConfig, {
          providerId: provider,
        });
        const cfg = await resolveLocalCapabilityRuntimeConfig({
          commandName: "infer web search",
          ...scopedTargets,
          config: rawConfig,
        });
        return runWebSearch({
          config: cfg,
          providerId: provider,
          args: {
            query,
            count: limit,
            limit,
          },
        });
      }),
    );

  web
    .command("fetch")
    .description("Fetch one URL")
    .requiredOption("--url <url>", "URL")
    .option("--provider <id>", "Provider id")
    .option("--format <format>", "Format hint")
    .option("--json", "Output JSON", false)
    .action((opts) =>
      runWebCommand("web.fetch", opts.json, async () => {
        const url = String(opts.url);
        const provider = opts.provider as string | undefined;
        const format = opts.format as string | undefined;
        const { getRuntimeConfig } = await import("../../config/config.js");
        const { getCapabilityWebFetchCommandSecretTargets } =
          await import("../command-secret-targets.js");
        const { resolveLocalCapabilityRuntimeConfig } = await import("./shared.js");
        const { resolveWebFetchDefinition } = await import("../../web-fetch/runtime.js");
        const rawConfig = getRuntimeConfig();
        const scopedTargets = getCapabilityWebFetchCommandSecretTargets(rawConfig, {
          providerId: provider,
        });
        const cfg = await resolveLocalCapabilityRuntimeConfig({
          commandName: "infer web fetch",
          ...scopedTargets,
          config: rawConfig,
        });
        const resolved = resolveWebFetchDefinition({
          config: cfg,
          providerId: provider,
        });
        if (!resolved) {
          throw new Error("web.fetch is disabled or no provider is available.");
        }
        const result = await resolved.definition.execute({
          url,
          extractMode: format,
        });
        return { provider: resolved.provider.id, result };
      }),
    );

  registerLocalProvidersCommand(web, "List web providers", async (cfg, agentId) => {
    const { resolveAgentDir } = await import("../../agents/agent-scope.js");
    const { isWebFetchProviderConfigured, listWebFetchProviders } =
      await import("../../web-fetch/runtime.js");
    const { isWebSearchProviderConfigured, listWebSearchProviders } =
      await import("../../web-search/runtime.js");
    const agentDir = resolveAgentDir(cfg, agentId);
    const { ensureAuthProfileStoreWithoutExternalProfilesAsync } =
      await import("../../agents/auth-profiles/store-runtime.js");
    const authStore = await ensureAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
    const selectedSearchProvider = normalizeLowercaseStringOrEmpty(
      cfg.tools?.web?.search?.provider,
    );
    const selectedFetchProvider = normalizeLowercaseStringOrEmpty(cfg.tools?.web?.fetch?.provider);
    return {
      search: listWebSearchProviders({ config: cfg }).map((provider) => ({
        available: true,
        configured: isWebSearchProviderConfigured({ provider, config: cfg, agentDir, authStore }),
        selected: provider.id === selectedSearchProvider,
        id: provider.id,
        envVars: provider.envVars,
      })),
      fetch: listWebFetchProviders({ config: cfg }).map((provider) => ({
        available: true,
        configured: isWebFetchProviderConfigured({ provider, config: cfg }),
        selected: provider.id === selectedFetchProvider,
        id: provider.id,
        envVars: provider.envVars,
      })),
    };
  });
}
