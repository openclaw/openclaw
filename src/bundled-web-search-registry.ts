import bravePlugin from "../extensions/brave/index.js";
import firecrawlPlugin from "../extensions/firecrawl/index.js";
import googlePlugin from "../extensions/google/index.js";
import moonshotPlugin from "../extensions/moonshot/index.js";
import perplexityPlugin from "../extensions/perplexity/index.js";
import tavilyPlugin from "../extensions/tavily/index.js";
import xaiPlugin from "../extensions/xai/index.js";
import type { OpenClawPluginApi } from "./plugins/types.js";

type RegistrablePlugin = {
  id: string;
  register: (api: OpenClawPluginApi) => void;
};

export const bundledWebSearchPluginRegistrations: ReadonlyArray<{
  plugin: RegistrablePlugin;
  credentialValue: unknown;
}> = [
  { plugin: bravePlugin, credentialValue: "BSA-test" },
  { plugin: firecrawlPlugin, credentialValue: "fc-test" },
  { plugin: googlePlugin, credentialValue: "AIza-test" },
  { plugin: moonshotPlugin, credentialValue: "sk-test" },
  { plugin: perplexityPlugin, credentialValue: "pplx-test" },
  { plugin: tavilyPlugin, credentialValue: "tvly-test" },
  { plugin: xaiPlugin, credentialValue: "xai-test" },
];
