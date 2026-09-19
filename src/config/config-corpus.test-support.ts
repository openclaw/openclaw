import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type operatorContainer from "../../test/fixtures/config-corpus/operator-container.json";
import type peanutto from "../../test/fixtures/config-corpus/peanutto.json";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/config-corpus/", import.meta.url));

export function listConfigCorpusFixtureNames(): string[] {
  return [
    ...fs.readdirSync(corpusDir).filter((name) => name.endsWith(".json")),
    "hamverbot.json",
  ].toSorted();
}

function readOperatorContainer() {
  const config: typeof operatorContainer = JSON.parse(
    fs.readFileSync(path.join(corpusDir, "operator-container.json"), "utf8"),
  );
  config.skills.entries = Object.fromEntries(
    [
      "1password",
      "apple-notes",
      "apple-reminders",
      "bear-notes",
      "blogwatcher",
      "blucli",
      "bluebubbles",
      "camsnap",
      "clawhub",
      "coding-agent",
      "discord",
      "eightctl",
      "gemini",
      "gifgrep",
      "gog",
      "goplaces",
      "himalaya",
      "imsg",
      "mcporter",
      "model-usage",
      "nano-pdf",
      "notion",
      "obsidian",
      "openai-whisper",
      "openai-whisper-api",
      "openhue",
      "oracle",
      "ordercli",
      "peekaboo",
      "sag",
      "session-logs",
      "sherpa-onnx-tts",
      "slack",
      "songsee",
      "sonoscli",
      "spotify-player",
      "things-mac",
      "trello",
      "video-frames",
      "voice-call",
      "wacli",
      "xurl",
      "gh-issues",
      "github",
      "summarize",
      "tmux",
    ].map((name) => [name, { enabled: false }]),
  );
  return config;
}

function readPeanuttoFixture(): string {
  const config: typeof peanutto = JSON.parse(
    fs.readFileSync(path.join(corpusDir, "peanutto.json"), "utf8"),
  );
  config.models.providers.ollama.models.push(
    ...[
      { id: "mistral-large-3:675b", name: "fixture-25" },
      { id: "nemotron-3-nano:30b", name: "fixture-26" },
      { id: "glm-5.3-flash", name: "fixture-27" },
      { id: "gpt-oss:120b", name: "fixture-28" },
      { id: "gpt-oss:20b", name: "fixture-29" },
      { id: "deepseek-v4-pro:0813", name: "fixture-30" },
      { id: "deepseek-v4-flash:0731", name: "fixture-31" },
      { id: "glm-5.3", name: "fixture-32" },
      { id: "gemma4:31b", name: "fixture-33" },
      { id: "kimi-k2.6", name: "fixture-34" },
      { id: "kimi-k2.7-code", name: "fixture-35" },
      { id: "qwen3.5:397b", name: "fixture-36" },
      { id: "nemotron-3-super", name: "fixture-37" },
      { id: "nemotron-3-ultra", name: "fixture-38" },
    ].map(({ id, name }) => ({
      id,
      name,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
      compat: {
        supportsTools: true,
        supportsUsageInStreaming: true,
        supportsJsonSchemaResponseFormat: true,
      },
      params: { num_ctx: 128000 },
    })),
  );
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function readConfigCorpusFixture(name: string): string {
  if (name === "operator-container.json") {
    return `${JSON.stringify(readOperatorContainer(), null, 2)}\n`;
  }
  if (name === "peanutto.json") {
    return readPeanuttoFixture();
  }
  if (name !== "hamverbot.json") {
    return fs.readFileSync(path.join(corpusDir, name), "utf8");
  }
  const config = readOperatorContainer();
  config.env.vars.BH_CONFIG_DIR = "/home/fixture/path0-0/path1-0/path2-0/path3-0";
  const models = config.agents.defaults.models;
  models["openai/gpt-5.4-nano"].alias = "fixture-13";
  models["openai/gpt-5.4-pro"].alias = "fixture-14";
  models["openai/gpt-5.4"].alias = "fixture-15";
  models["xai/grok-4.3"].alias = "fixture-16";
  models["anthropic/claude-opus-4-8"].alias = "fixture-17";
  models["anthropic/claude-sonnet-4-6"].alias = "fixture-18";
  models["xai/auto"].alias = "fixture-19";
  config.agents.defaults.heartbeat.to = "900000020";
  config.commands.ownerAllowFrom = ["telegram:900000020"];
  config.channels.telegram.allowFrom = ["900000020"];
  config.gateway.controlUi.allowedOrigins = [
    "http://fixture-25.invalid:18789/",
    "http://fixture-26.invalid:18789/",
    "http://fixture-27.invalid:18789/",
    "http://fixture-28.invalid:18789/",
    "http://fixture-29.invalid:18789/",
    "https://fixture-30.invalid/",
  ];
  config.diagnostics.otel.endpoint = "http://fixture-32.invalid:4318/";
  config.diagnostics.otel.serviceName = "fixture-33";
  const xai = config.models.providers.xai;
  const { "fixture-extension": fixtureExtension, ...otherPlugins } = config.plugins.entries;
  const variant = {
    ...config,
    models: {
      ...config.models,
      providers: {
        ...config.models.providers,
        xai: {
          ...xai,
          models: [
            { ...xai.models[0], name: "fixture-6" },
            { ...xai.models[1], name: "fixture-7" },
            { ...xai.models[2], name: "fixture-8" },
            { ...xai.models[3], name: "fixture-9" },
            { ...xai.models[4], name: "fixture-10" },
            { ...xai.models[5], name: "fixture-11" },
            { ...xai.models[6], name: "fixture-12" },
          ],
        },
      },
    },
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents.defaults,
        models: {
          "openai/gpt-5.4-mini": models["openai/gpt-5.4-mini"],
          "openai/gpt-5.4-nano": models["openai/gpt-5.4-nano"],
          "openai/gpt-5.4-pro": models["openai/gpt-5.4-pro"],
          "openai/gpt-5.4": models["openai/gpt-5.4"],
          "xai/grok-4.3": models["xai/grok-4.3"],
          "anthropic/fixture-model-5": models["anthropic/claude-opus-4-8"],
          "anthropic/fixture-model-6": models["anthropic/claude-sonnet-4-6"],
          "anthropic/fixture-model-7": models["anthropic/claude-opus-4-7"],
          "anthropic/fixture-model-8": models["anthropic/claude-opus-4-6"],
          "xai/auto": models["xai/auto"],
        },
      },
    },
    channels: {
      ...config.channels,
      telegram: {
        ...config.channels.telegram,
        groups: {
          "-9000000000021": { requireMention: false },
          "-9000000022": { requireMention: false },
          "-9000000023": { requireMention: false },
          "-9000000000024": { requireMention: false },
        },
      },
    },
    plugins: {
      ...config.plugins,
      entries: { ...otherPlugins, "fixture-extension": fixtureExtension },
    },
  };
  return `${JSON.stringify(variant, null, 2)}\n`;
}
