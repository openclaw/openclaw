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

describe("command secret resolution coverage", () => {
  it.each(SECRET_TARGET_CALLSITES)(
    "routes target-id command path through shared gateway resolver: %s",
    async (relativePath) => {
      const absolutePath = path.join(process.cwd(), relativePath);
      const source = await fs.readFile(absolutePath, "utf8");
      expect(source).toContain("resolveCommandSecretRefsViaGateway");
      expect(source).toContain("targetIds: get");
      expect(source).toContain("resolveCommandSecretRefsViaGateway({");
    },
  );
});
