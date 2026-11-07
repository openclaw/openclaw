import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startNodeHostMcpManager, type NodeHostMcpManager } from "./mcp.js";

const require = createRequire(import.meta.url);

type McpCallResult = Awaited<ReturnType<NodeHostMcpManager["callMcpTool"]>>;

function resultText(result: McpCallResult): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "";
}

// Real-behavior coverage for the dispose-retry recovery: a real stdio MCP server
// process, the real SDK client, and the real supervised transport. The cleanup
// fault is injected at the exact production boundary the fix guards — the
// stderr-detach callback (`stderr.off("data", onData)` from attachStderrLogging)
// — so the real disposeMcpClient rejects from its finally block. Requires the
// supervised stdio runtime (pinned Bun) like the other *.real.test.ts lanes.
describe("node host MCP dispose-retry real recovery", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it(
    "warns with the operator action, reconnects, republishes tools, and serves a later call",
    { timeout: 90_000 },
    async () => {
      root = await mkdtemp(path.join(tmpdir(), "node-mcp-dispose-real-"));
      const serverPath = path.join(root, "server.mjs");
      const pidPath = path.join(root, "server.pid");
      await writeFile(
        serverPath,
        `import fs from "node:fs";
import { McpServer } from ${JSON.stringify(require.resolve("@modelcontextprotocol/server"))};
import { StdioServerTransport } from ${JSON.stringify(require.resolve("@modelcontextprotocol/server/stdio"))};
import { z } from ${JSON.stringify(require.resolve("zod"))};
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const server = new McpServer({ name: "dispose-proof", version: "1" });
server.registerTool(
  "echo",
  { description: "Echo the input value", inputSchema: { value: z.string() } },
  async ({ value }) => ({
    content: [{ type: "text", text: \`echo:\${value} pid=\${process.pid}\` }],
  }),
);
await server.connect(new StdioServerTransport());
`,
      );

      const warnings: string[] = [];
      const originalWarn = console.warn.bind(console);
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "));
        originalWarn(...args);
      };

      // The only `PassThrough#off("data", ...)` in this process is the
      // stderr-detach callback created by attachStderrLogging; arm the single
      // throw right before the kill so it lands on that production path.
      const originalOff = Reflect.get(PassThrough.prototype, "off") as (
        this: PassThrough,
        event: string | symbol,
        listener: (...args: never[]) => void,
      ) => PassThrough;
      let faultArmed = false;
      (PassThrough.prototype as { off: unknown }).off = function (
        this: PassThrough,
        event: string | symbol,
        listener: (...args: never[]) => void,
      ) {
        if (faultArmed && event === "data") {
          faultArmed = false;
          throw new Error("proof-injected stderr detach failure");
        }
        return originalOff.call(this, event, listener);
      };

      const readPid = async () => (await readFile(pidPath, "utf8")).trim();
      const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string) => {
        const deadline = Date.now() + 30_000;
        for (;;) {
          if (await predicate()) {
            return;
          }
          if (Date.now() >= deadline) {
            throw new Error(`timed out waiting for ${what}`);
          }
          await delay(50);
        }
      };

      try {
        const manager = await startNodeHostMcpManager({
          proof: {
            transport: "stdio",
            command: process.execPath,
            args: [serverPath],
            env: { PROOF_PID_FILE: pidPath },
          },
        });
        try {
          const toolNames = () =>
            manager.descriptors.filter((d) => d.mcp?.server === "proof").map((d) => d.mcp?.tool);

          await waitFor(() => toolNames().includes("echo"), "initial tool publication");
          const initialPid = await readPid();
          console.log(`[real] initial tools published, server pid=${initialPid}`);

          const before = await manager.callMcpTool({
            server: "proof",
            tool: "echo",
            arguments: { value: "before-disconnect" },
          });
          expect(resultText(before)).toContain("echo:before-disconnect");
          console.log(`[real] call before disconnect: ${resultText(before)}`);

          faultArmed = true;
          process.kill(Number(initialPid), "SIGKILL");
          console.log(`[real] SIGKILL server pid=${initialPid}; cleanup fault armed`);

          await waitFor(
            () => warnings.some((w) => w.includes("cleanup failed")),
            "cleanup-failed warning",
          );
          const cleanupWarning = warnings.find((w) => w.includes("cleanup failed")) ?? "";
          console.log(`[real] cleanup warning: ${cleanupWarning}`);
          expect(cleanupWarning).toContain("check the server process");

          await waitFor(() => toolNames().includes("echo"), "tool republication");
          const recoveredPid = await readPid();
          console.log(`[real] tools republished, server pid=${recoveredPid}`);
          expect(recoveredPid).not.toBe(initialPid);

          const after = await manager.callMcpTool({
            server: "proof",
            tool: "echo",
            arguments: { value: "after-recovery" },
          });
          console.log(`[real] call after recovery: ${resultText(after)}`);
          expect(resultText(after)).toContain("echo:after-recovery");
        } finally {
          await manager.close();
        }
      } finally {
        (PassThrough.prototype as { off: unknown }).off = originalOff;
        console.warn = originalWarn;
      }
    },
  );
});
