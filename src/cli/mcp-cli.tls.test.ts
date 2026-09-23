import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

async function writeMcpServers(home: string, servers: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(home, ".openclaw", "openclaw.json"),
    `${JSON.stringify({ mcp: { servers } })}\n`,
    "utf8",
  );
}

describe("MCP Doctor TLS files", () => {
  beforeEach(resetMcpCliTestState);
  afterEach(cleanupMcpCliTestState);

  it("preflights the runtime TLS file limit without probing an MCP server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      const accepted = path.join(workspaceDir, "accepted.pem");
      const oversized = path.join(workspaceDir, "oversized.pem");
      await fs.writeFile(accepted, "x".repeat(64 * 1024));
      await fs.writeFile(oversized, "x".repeat(64 * 1024 + 1));
      const server = { url: "https://mcp.example.com/mcp", transport: "streamable-http" };
      await writeMcpServers(home, {
        accepted: { ...server, clientCert: accepted, clientKey: accepted },
        certificate: { ...server, clientCert: oversized },
        key: { ...server, clientKey: oversized },
      });

      await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toThrow("__exit__:1");

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: false,
        servers: [
          { name: "accepted", ok: true, issues: [] },
          {
            name: "certificate",
            ok: false,
            issues: [{ level: "error", message: expect.stringContaining("exceeds 65536 bytes") }],
          },
          {
            name: "key",
            ok: false,
            issues: [{ level: "error", message: expect.stringContaining("exceeds 65536 bytes") }],
          },
        ],
      });
    });
  });
});
