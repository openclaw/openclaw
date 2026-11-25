import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectConfiguredSpeechProviderIds } from "./gateway-startup-speech-providers.js";

it("bounds fleet roster traversal and observes later speech configuration changes", () => {
  const agentCount = 64;
  const entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]> = Object.fromEntries(
    Array.from({ length: agentCount }, (_, index) => [
      `agent-${index}`,
      { tts: { provider: "blocked", persona: "narrator" } },
    ]),
  );
  const lastAgent = `agent-${agentCount - 1}`;
  entries[lastAgent] = { tts: { provider: "agent-provider", persona: "narrator" } };
  let rosterTraversals = 0;
  const cfg: OpenClawConfig = {
    agents: {
      entries: new Proxy(entries, {
        ownKeys(target) {
          rosterTraversals += 1;
          return Reflect.ownKeys(target);
        },
      }),
    },
    tts: {
      providers: { base: {}, blocked: { enabled: false } },
      personas: { narrator: { label: "Narrator", provider: "persona-provider" } },
    },
  };

  expect([...collectConfiguredSpeechProviderIds(cfg)].toSorted()).toEqual([
    "agent-provider",
    "base",
    "persona-provider",
  ]);
  // Inventory scans must stay bounded as agents grow; each agent still resolves its own TTS.
  expect(rosterTraversals).toBeLessThanOrEqual(4);

  entries[lastAgent] = { tts: { provider: "changed-agent", persona: "narrator" } };
  cfg.tts!.personas!.narrator = { label: "Narrator", provider: "changed-persona" };
  rosterTraversals = 0;

  expect([...collectConfiguredSpeechProviderIds(cfg)].toSorted()).toEqual([
    "base",
    "changed-agent",
    "changed-persona",
  ]);
  expect(rosterTraversals).toBeLessThanOrEqual(4);
});
