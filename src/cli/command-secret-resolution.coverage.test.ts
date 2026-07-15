// Command secret resolution coverage tests cover plugin secret resolution branches.
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { readCommandSource } from "./command-source.test-helpers.js";

const SECRET_TARGET_CALLSITES = [
  bundledPluginFile("memory-core", "src/cli.runtime.ts"),
  "src/cli/qr-cli.ts",
  "src/agents/agent-runtime-config.ts",
  "src/agents/command/prepare.ts",
  "src/cli/capability-cli.audio.ts",
  "src/cli/capability-cli.embedding.ts",
  "src/cli/capability-cli.image.ts",
  "src/cli/capability-cli.model.ts",
  "src/cli/capability-cli.shared.ts",
  "src/cli/capability-cli.tts.ts",
  "src/cli/capability-cli.video.ts",
  "src/cli/capability-cli.web.ts",
  "src/commands/channels/resolve.ts",
  "src/commands/channels/shared.ts",
  "src/commands/message.ts",
  "src/commands/models/load-config.ts",
  "src/commands/status-all.ts",
  "src/commands/status.scan.ts",
] as const;

function hasSupportedTargetIdsWiring(source: string): boolean {
  return (
    source.includes("resolveAgentRuntimeConfig(") ||
    /targetIds:\s*get[A-Za-z0-9_]+\(\)/m.test(source) ||
    /targetIds:\s*getAgentRuntimeCommandSecretTargetIds\(/m.test(source) ||
    /targetIds:\s*getCapabilityWeb(Fetch|Search)CommandSecretTargetIds\(/m.test(source) ||
    /targetIds:\s*params\.targetIds/m.test(source) ||
    /targetIds:\s*scopedTargets\.targetIds/m.test(source) ||
    source.includes("collectStatusScanOverview({")
  );
}

function hasSupportedSecretResolutionWiring(source: string): boolean {
  return (
    source.includes("resolveAgentRuntimeConfig(") ||
    source.includes("resolveCommandConfigWithSecrets(") ||
    source.includes("resolveLocalCapabilityRuntimeConfig(") ||
    source.includes("resolveCommandSecretRefsViaGateway(") ||
    source.includes("collectStatusScanOverview(")
  );
}

function usesDelegatedStatusOverviewFlow(source: string): boolean {
  return source.includes("collectStatusScanOverview(");
}

describe("command secret resolution coverage", () => {
  it.each(SECRET_TARGET_CALLSITES)(
    "routes target-id command path through shared secret resolution flow: %s",
    async (relativePath) => {
      const source = await readCommandSource(relativePath);
      expect(hasSupportedSecretResolutionWiring(source)).toBe(true);
      if (!usesDelegatedStatusOverviewFlow(source)) {
        expect(hasSupportedTargetIdsWiring(source)).toBe(true);
      }
    },
  );
});
