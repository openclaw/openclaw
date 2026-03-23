import bravePlugin from "../extensions/brave/index.js";
import exaPlugin from "../extensions/exa/index.js";
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
  readonly plugin: RegistrablePlugin;
  credentialValue: unknown;
}> = [
  {
    get plugin() {
      return bravePlugin;
    },
    credentialValue: "BSA-test",
  },
  {
    get plugin() {
      return exaPlugin;
    },
    credentialValue: "exa-test",
  },
  {
    get plugin() {
      return firecrawlPlugin;
    },
    credentialValue: "fc-test",
  },
  {
    get plugin() {
      return googlePlugin;
    },
    credentialValue: "AIza-test",
  },
  {
    get plugin() {
      return moonshotPlugin;
    },
    credentialValue: "sk-test",
  },
  {
    get plugin() {
      return perplexityPlugin;
    },
    credentialValue: "pplx-test",
  },
  {
    get plugin() {
      return tavilyPlugin;
    },
    credentialValue: "tvly-test",
  },
  {
    get plugin() {
      return xaiPlugin;
    },
    credentialValue: "xai-test",
  },
];
