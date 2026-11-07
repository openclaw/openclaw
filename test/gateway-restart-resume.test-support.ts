import type { OpenClawConfig } from "../src/config/config.js";
import type { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { restartModelConfig } from "./gateway-restart.test-support.js";

export function restartResumeConfig(
  model: ReturnType<typeof buildMockOpenAiResponsesProvider>,
  store?: string,
): OpenClawConfig {
  const base = restartModelConfig(model, undefined, {
    maxConcurrent: 12,
    compaction: {
      mode: "default",
      keepRecentTokens: 1,
      recentTurnsPreserve: 0,
      memoryFlush: { enabled: false },
    },
  });
  return {
    update: { checkOnStart: false },
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    plugins: { enabled: false },
    ...base,
    agents: { ...base.agents, ownership: "explicit", entries: { main: {}, other: {} } },
    ...(store ? { session: { store } } : {}),
    messages: { queue: { mode: "followup" } },
    tools: {
      allow: ["exec", "process", "sessions_spawn", "sessions_list"],
      codeMode: { enabled: false },
      exec: { host: "gateway", security: "full", ask: "off" },
    },
  };
}
