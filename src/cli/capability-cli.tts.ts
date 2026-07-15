import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { getRuntimeConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import { isLoopbackHost } from "../gateway/net.js";
import { defaultRuntime } from "../runtime.js";
import { canonicalizeSpeechProviderId, listSpeechProviders } from "../tts/provider-registry.js";
import {
  getTtsProvider,
  getTtsPersona,
  listTtsPersonas,
  listSpeechVoices,
  resolveExplicitTtsOverrides,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setTtsEnabled,
  setTtsPersona,
  setTtsProvider,
  textToSpeech,
} from "../tts/tts.js";
import {
  emitJsonOrText,
  formatEnvelopeForText,
  pinRuntimeConfigSnapshot,
  providerHasGenericConfig,
  providerSummaryText,
  resolveLocalCapabilityRuntimeConfig,
  resolveModelRefOverride,
  resolveTransport,
  type CapabilityEnvelope,
  type CapabilityTransport,
} from "./capability-cli.shared.js";
import {
  injectTtsAuthProfileApiKey,
  resolveTtsProviderForAuthHydration,
} from "./capability-cli.tts-auth.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { getTtsCommandSecretTargetIds } from "./command-secret-targets.js";

async function runTtsConvert(params: {
  text: string;
  channel?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
  output?: string;
  transport: CapabilityTransport;
}) {
  if (params.transport === "gateway") {
    const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({
      config: getRuntimeConfig(),
    });
    const result: {
      audioPath?: string;
      provider?: string;
      outputFormat?: string;
      voiceCompatible?: boolean;
    } = await callGateway({
      method: "tts.convert",
      params: {
        text: params.text,
        channel: params.channel,
        provider: normalizeOptionalString(params.provider),
        modelId: params.modelId,
        voiceId: params.voiceId,
      },
      timeoutMs: 120_000,
    });
    let outputPath = result.audioPath;
    if (params.output && result.audioPath) {
      const gatewayHost = new URL(gatewayConnection.url).hostname;
      if (!isLoopbackHost(gatewayHost)) {
        throw new Error(
          `--output is not supported for remote gateway TTS yet (gateway target: ${gatewayConnection.url}).`,
        );
      }
      const target = path.resolve(params.output);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(result.audioPath, target);
      outputPath = target;
    }
    return {
      ok: true,
      capability: "tts.convert",
      transport: "gateway" as const,
      provider: result.provider,
      attempts: [],
      outputs: [
        {
          path: outputPath,
          format: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
        },
      ],
    } satisfies CapabilityEnvelope;
  }

  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer tts convert",
    targetIds: getTtsCommandSecretTargetIds(),
  });
  const ttsProvider = resolveTtsProviderForAuthHydration({
    cfg,
    provider: params.provider,
    modelId: params.modelId,
    channelId: params.channel,
  });
  const effectiveCfg = await injectTtsAuthProfileApiKey({
    cfg,
    provider: ttsProvider,
    channelId: params.channel,
  });
  if (effectiveCfg !== cfg) {
    pinRuntimeConfigSnapshot(effectiveCfg);
  }
  const overrides = resolveExplicitTtsOverrides({
    cfg: effectiveCfg,
    provider: params.provider,
    modelId: params.modelId,
    voiceId: params.voiceId,
    channelId: params.channel,
  });
  const hasExplicitSelection = Boolean(
    overrides.provider ||
    normalizeOptionalString(params.modelId) ||
    normalizeOptionalString(params.voiceId),
  );
  const result = await textToSpeech({
    text: params.text,
    cfg: effectiveCfg,
    channel: params.channel,
    overrides,
    disableFallback: hasExplicitSelection,
  });
  if (!result.success || !result.audioPath) {
    throw new Error(result.error ?? "TTS conversion failed");
  }
  let outputPath = result.audioPath;
  if (params.output) {
    const target = path.resolve(params.output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(result.audioPath, target);
    outputPath = target;
  }
  return {
    ok: true,
    capability: "tts.convert",
    transport: "local" as const,
    provider: result.provider,
    attempts: result.attempts ?? [],
    outputs: [
      {
        path: outputPath,
        format: result.outputFormat,
        voiceCompatible: result.voiceCompatible,
      },
    ],
  } satisfies CapabilityEnvelope;
}

async function runTtsProviders(transport: CapabilityTransport) {
  const cfg = getRuntimeConfig();
  if (transport === "gateway") {
    const payload: {
      providers?: Array<Record<string, unknown>>;
      active?: string;
    } = await callGateway({
      method: "tts.providers",
      timeoutMs: 30_000,
    });
    return {
      ...payload,
      providers: (payload.providers ?? []).map((provider) => {
        const id = typeof provider.id === "string" ? provider.id : "";
        return Object.assign(
          {
            available: true,
            configured:
              typeof provider.configured === `boolean`
                ? provider.configured
                : providerHasGenericConfig({ cfg, providerId: id }),
            selected: Boolean(id && payload.active === id),
          },
          provider,
        );
      }),
    };
  }
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const active = getTtsProvider(config, prefsPath);
  return {
    providers: listSpeechProviders(cfg).map((provider) => ({
      available: true,
      configured:
        active === provider.id || providerHasGenericConfig({ cfg, providerId: provider.id }),
      selected: active === provider.id,
      id: provider.id,
      name: provider.label,
      models: [...(provider.models ?? [])],
      voices: [...(provider.voices ?? [])],
    })),
    active,
  };
}

async function runTtsPersonas(transport: CapabilityTransport) {
  if (transport === "gateway") {
    return await callGateway({
      method: "tts.personas",
      timeoutMs: 30_000,
    });
  }
  const cfg = getRuntimeConfig();
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const active = getTtsPersona(config, prefsPath);
  return {
    active: active?.id ?? null,
    personas: listTtsPersonas(config).map((persona) => ({
      id: persona.id,
      label: persona.label,
      description: persona.description,
      provider: persona.provider,
      fallbackPolicy: persona.fallbackPolicy,
      providers: Object.keys(persona.providers ?? {}),
    })),
  };
}

async function runTtsVoices(providerRaw?: string) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer tts voices",
    targetIds: getTtsCommandSecretTargetIds(),
  });
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const provider = normalizeOptionalString(providerRaw) || getTtsProvider(config, prefsPath);
  return await listSpeechVoices({
    provider,
    cfg,
    config,
  });
}

async function runTtsStateMutation(params: {
  capability: "tts.enable" | "tts.disable" | "tts.set-provider" | "tts.set-persona";
  transport: CapabilityTransport;
  provider?: string;
  persona?: string | null;
}) {
  if (params.transport === "gateway") {
    const method =
      params.capability === "tts.enable"
        ? "tts.enable"
        : params.capability === "tts.disable"
          ? "tts.disable"
          : params.capability === "tts.set-provider"
            ? "tts.setProvider"
            : "tts.setPersona";
    const payload = await callGateway({
      method,
      params:
        params.capability === "tts.set-provider"
          ? { provider: params.provider }
          : params.capability === "tts.set-persona"
            ? { persona: params.persona ?? "off" }
            : undefined,
      timeoutMs: 30_000,
    });
    return payload;
  }

  const cfg = getRuntimeConfig();
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  if (params.capability === "tts.enable") {
    setTtsEnabled(prefsPath, true);
    return { enabled: true };
  }
  if (params.capability === "tts.disable") {
    setTtsEnabled(prefsPath, false);
    return { enabled: false };
  }
  if (params.capability === "tts.set-persona") {
    if (!params.persona) {
      setTtsPersona(prefsPath, null);
      return { persona: null };
    }
    const persona = listTtsPersonas(config).find(
      (entry) => entry.id === normalizeLowercaseStringOrEmpty(params.persona ?? ""),
    );
    if (!persona) {
      throw new Error(`Unknown TTS persona: ${params.persona}`);
    }
    setTtsPersona(prefsPath, persona.id);
    return { persona: persona.id };
  }
  if (!params.provider) {
    throw new Error("--provider is required");
  }
  const provider = canonicalizeSpeechProviderId(params.provider, cfg);
  if (!provider) {
    throw new Error(`Unknown speech provider: ${params.provider}`);
  }
  setTtsProvider(prefsPath, provider);
  return { provider };
}

export function registerTtsCapabilityCommands(capability: Command) {
  const tts = capability.command("tts").description("Text to speech");

  tts
    .command("convert")
    .description("Convert text to speech")
    .requiredOption("--text <text>", "Input text")
    .option("--channel <id>", "Channel hint")
    .option("--voice <id>", "Voice hint")
    .option("--model <provider/model>", "Model override")
    .option("--output <path>", "Output path")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "local",
        });
        const modelRef = resolveModelRefOverride(opts.model as string | undefined);
        if (opts.model && !modelRef.provider) {
          throw new Error("TTS model overrides must use the form <provider/model>.");
        }
        const result = await runTtsConvert({
          text: String(opts.text),
          channel: opts.channel as string | undefined,
          provider: modelRef.provider,
          modelId: modelRef.provider ? modelRef.model : undefined,
          voiceId: opts.voice as string | undefined,
          output: opts.output as string | undefined,
          transport,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  tts
    .command("voices")
    .description("List voices for a TTS provider")
    .option("--provider <id>", "Speech provider id")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const voices = await runTtsVoices(opts.provider as string | undefined);
        emitJsonOrText(defaultRuntime, Boolean(opts.json), voices, providerSummaryText);
      });
    });

  tts
    .command("providers")
    .description("List speech providers")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "local",
        });
        const result = await runTtsProviders(transport);
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  tts
    .command("personas")
    .description("List TTS personas")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "local",
        });
        const result = await runTtsPersonas(transport);
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  tts
    .command("status")
    .description("Show TTS status")
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          gateway: Boolean(opts.gateway),
          supported: ["gateway"],
          defaultTransport: "gateway",
        });
        const result = await callGateway({
          method: "tts.status",
          timeoutMs: 30_000,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), { transport, ...result }, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  for (const [commandName, capabilityId] of [
    ["enable", "tts.enable"],
    ["disable", "tts.disable"],
  ] as const) {
    tts
      .command(commandName)
      .description(`${commandName === "enable" ? "Enable" : "Disable"} TTS`)
      .option("--local", "Force local execution", false)
      .option("--gateway", "Force gateway execution", false)
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        await runCommandWithRuntime(defaultRuntime, async () => {
          const transport = resolveTransport({
            local: Boolean(opts.local),
            gateway: Boolean(opts.gateway),
            supported: ["local", "gateway"],
            defaultTransport: "gateway",
          });
          const result = await runTtsStateMutation({
            capability: capabilityId,
            transport,
          });
          emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
            JSON.stringify(value, null, 2),
          );
        });
      });
  }

  tts
    .command("set-provider")
    .description("Set the active TTS provider")
    .requiredOption("--provider <id>", "Speech provider id")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "gateway",
        });
        const result = await runTtsStateMutation({
          capability: "tts.set-provider",
          provider: String(opts.provider),
          transport,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  tts
    .command("set-persona")
    .description("Set the active TTS persona")
    .option("--persona <id>", "TTS persona id")
    .option("--off", "Disable the active TTS persona", false)
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "gateway",
        });
        if (!opts.off && !opts.persona) {
          throw new Error("--persona is required unless --off is set");
        }
        const result = await runTtsStateMutation({
          capability: "tts.set-persona",
          persona: opts.off ? null : String(opts.persona),
          transport,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });
}
