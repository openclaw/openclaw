import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import {
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SHUTDOWN_WARNING = "gateway_stop hook exceeded 2500ms; continuing";
it.each([
  { name: "successful JSON", fail: false, json: true, pending: false },
  { name: "successful text", fail: false, json: false, pending: false },
  { name: "failed JSON", fail: true, json: true, pending: false },
  { name: "failed text", fail: true, json: false, pending: false },
  { name: "stalled cleanup", fail: false, json: true, pending: true },
])("runs owned shutdown hooks after $name output", async ({ fail, json, pending }) => {
  const root = tempDirs.make("openclaw-message-cleanup-");
  const pluginDir = path.join(root, "plugin");
  const configPath = path.join(root, "openclaw.json");
  const marker = path.join(root, "stopped.txt");
  const id = "cleanup";
  const mediaUrls = ["https://example.com/first.png", "https://example.com/second.png"] as const;
  const meta = { id, label: id, selectionLabel: id, docsPath: "/channels/test", blurb: id };
  const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
  await fs.mkdir(pluginDir);
  await writeJson(path.join(pluginDir, "package.json"), {
    name: id,
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"], setupEntry: "./index.js", channel: meta },
  });
  await writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id,
    channels: [id],
    configSchema: { type: "object" },
    channelConfigs: { [id]: { schema: { type: "object" } } },
  });
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `import fs from "node:fs";
export const plugin = {
  id: ${JSON.stringify(id)}, meta: ${JSON.stringify(meta)},
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ accountId: "default", enabled: true }),
    isConfigured: () => true, isEnabled: () => true,
  },
  messaging: {
    normalizeTarget(raw) { ${fail ? 'throw new Error("synthetic target failure");' : "return raw;"} },
    targetResolver: { looksLikeId: () => true },
  },
  outbound: { deliveryMode: "direct", sendText() { throw new Error("dry-run must not send"); } },
};
export default { id: plugin.id, register(api) {
  api.registerChannel({ plugin });
  api.on("gateway_stop", () => {
    fs.appendFileSync(${JSON.stringify(marker)}, "stopped\\n");
    ${pending ? "return new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.resume(); });" : "return Promise.resolve();"}
  });
} };`,
  );
  await writeJson(configPath, {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { load: { paths: [pluginDir] }, entries: { [id]: { enabled: true } } },
    channels: { [id]: { enabled: true } },
    logging: { level: "silent", consoleLevel: "silent" },
  });
  const nodeArgs = resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli));
  nodeArgs.push("message", "send", "--dry-run");
  nodeArgs.push("--channel", id, "--target", "user:synthetic");
  nodeArgs.push("--media", mediaUrls[0], "--message", "Synthetic payload");
  nodeArgs.push("--media", mediaUrls[1], ...(json ? ["--json"] : []));
  const result = await runCliProcessChild({
    interact: pending
      ? async (child) => {
          try {
            await waitForCliProcessStderrMarker(child, SHUTDOWN_WARNING);
            expect(child.exitCode).toBeNull();
          } finally {
            child.stdin.end();
          }
        }
      : undefined,
    nodeArgs,
    env: {
      PATH: process.env.PATH,
      ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
      HOME: root,
      USERPROFILE: root,
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NO_COLOR: "1",
    },
  });
  expect(result, result.stderr).toMatchObject({ signal: null, code: fail ? 1 : 0 });
  await expect(fs.readFile(marker, "utf8")).resolves.toBe("stopped\n");
  if (json) {
    expect(JSON.parse(result.stdout)).toMatchObject(
      fail
        ? { ok: false, error: { message: "synthetic target failure" } }
        : { dryRun: true, payload: { mediaUrls } },
    );
  }
  if (pending) {
    expect(result.stderr).toContain(SHUTDOWN_WARNING);
  }
});
