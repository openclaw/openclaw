import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { openFixtureReceiptChannel } from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import {
  waitForRuntimeState,
  writeListToolsMcpServer,
} from "../agents/agent-bundle-mcp-stdio.test-support.js";
import { loadMergedBundleMcpConfig } from "../agents/bundle-mcp-config.js";
import { loadPluginManifest } from "./manifest.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const rootDir = fileURLToPath(new URL("../../extensions/phoneuse/", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: Awaited<ReturnType<typeof openFixtureReceiptChannel>>;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

function phoneuseRegistry() {
  const loaded = loadPluginManifest(rootDir);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  return {
    plugins: [
      createPluginManifestRecordFixture({ ...loaded.manifest, rootDir, format: "openclaw" }),
    ],
  };
}

const enabled = { entries: { phoneuse: { enabled: true } } };

it("keeps Phoneuse opt-in and honors operator and session disablement", () => {
  const workspaceDir = tempDirs.make("phoneuse-policy-");
  const manifestRegistry = phoneuseRegistry();
  const load = (cfg: Parameters<typeof loadMergedBundleMcpConfig>[0]["cfg"], session = false) =>
    loadMergedBundleMcpConfig({
      workspaceDir,
      manifestRegistry,
      cfg,
      ...(session ? { toolOverrides: { mcpServers: { phoneuse: false } } } : {}),
    }).config.mcpServers;
  expect(load({})).toEqual({});
  expect(load({ plugins: enabled })).toMatchObject({
    phoneuse: { command: "phoneuse-mcp", transport: "stdio" },
  });
  expect(load({ plugins: enabled, mcp: { servers: { phoneuse: { enabled: false } } } })).toEqual(
    {},
  );
  expect(load({ plugins: enabled }, true)).toEqual({});
});

it("does not replay an accepted action after stdio loss and reconnects for explicit observation", async ({
  signal,
}) => {
  // A synthetic MCP peer exercises the host transport, not Bluetooth/AirPlay or OCR freshness.
  const workspaceDir = tempDirs.make("phoneuse-uncertain-effect-");
  const filePath = path.join(workspaceDir, "server.mjs");
  const logPath = path.join(workspaceDir, "server.log");
  const pidPath = path.join(workspaceDir, "server.pid");
  await writeListToolsMcpServer(
    {
      filePath,
      logPath,
      pidPath,
      hangToolCallsUntilRestartMarkerPath: path.join(workspaceDir, "first-connection"),
      tools: ["tap", "look"].map((name) => ({ name, inputSchema: { type: "object" } })),
      callToolResult: { content: [{ type: "text", text: "synthetic new observation" }] },
    },
    receipts.endpoint,
  );
  const runtime = createSessionMcpRuntime({
    workspaceDir,
    sessionId: "phoneuse-proof",
    manifestRegistry: phoneuseRegistry(),
    cfg: {
      plugins: enabled,
      mcp: { servers: { phoneuse: { command: process.execPath, args: [filePath] } } },
    },
  });
  try {
    await runtime.getCatalog();
    const attempted = expect(
      runtime.callTool("phoneuse", "tap", { x: 0.5, y: 0.5 }),
    ).rejects.toThrow();
    await withinTest(receipts.waitFor(logPath, "hang tools/call"), signal);
    process.kill(Number.parseInt(await fs.readFile(pidPath, "utf8"), 10), "SIGKILL");
    await attempted;
    await waitForRuntimeState(
      async () => {
        const result = await runtime.callTool("phoneuse", "look", {}).catch(() => undefined);
        return (
          result?.content?.some(
            (item) => item.type === "text" && item.text === "synthetic new observation",
          ) ?? false
        );
      },
      "Phoneuse peer to reconnect for observation",
      signal,
    );
    expect((await fs.readFile(logPath, "utf8")).match(/^call tap$/gm)).toEqual(["call tap"]);
  } finally {
    await runtime.dispose();
    await runtime.joinCleanup?.();
  }
});
