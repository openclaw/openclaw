import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SECRET_TARGET_CALLSITES = [
  "src/cli/memory-cli.ts",
  "src/cli/qr-cli.ts",
  "src/commands/agent.ts",
  "src/commands/channels/resolve.ts",
  "src/commands/channels/shared.ts",
  "src/commands/message.ts",
  "src/commands/models/load-config.ts",
  "src/commands/status-all.ts",
  "src/commands/status.scan.ts",
] as const;

async function readCommandSource(relativePath: string): Promise<string> {
  const absolutePath = path.join(process.cwd(), relativePath);
  const source = await fs.readFile(absolutePath, "utf8");
  const reexportMatch = source.match(/^export \* from "(?<target>[^"]+)";$/m)?.groups?.target;
  if (!reexportMatch) {
    return source;
  }
  const resolvedTarget = path.join(path.dirname(absolutePath), reexportMatch);
  const tsResolvedTarget = resolvedTarget.replace(/\.js$/u, ".ts");
  return await fs.readFile(tsResolvedTarget, "utf8");
}

function hasSupportedTargetIdsWiring(source: string): boolean {
  return (
    /targetIds:\s*get[A-Za-z0-9_]+\(\)/m.test(source) ||
    /targetIds:\s*scopedTargets\.targetIds/m.test(source)
  );
}

describe("command secret resolution coverage", () => {
  it.each(SECRET_TARGET_CALLSITES)(
    "routes target-id command path through shared gateway resolver: %s",
    async (relativePath) => {
      const source = await readCommandSource(relativePath);
      expect(source).toContain("resolveCommandSecretRefsViaGateway");
      expect(hasSupportedTargetIdsWiring(source)).toBe(true);
      expect(source).toContain("resolveCommandSecretRefsViaGateway({");
    },
  );
});
