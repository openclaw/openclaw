import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { waitForCliProcessStderrMarker } from "./cli-process-child.test-helpers.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SHUTDOWN_WARNING = "gateway_stop hook exceeded 2500ms; continuing";
it.each([
  { name: "successful JSON", fail: false, json: true, pending: false },
  { name: "successful text", fail: false, json: false, pending: false },
  { name: "failed JSON", fail: true, json: true, pending: false },
  { name: "failed text", fail: true, json: false, pending: false },
  { name: "stalled cleanup", fail: false, json: true, pending: true },
  { name: "forward clock step", fail: false, json: true, pending: false, clockOffset: 60_000 },
  { name: "backward clock step", fail: false, json: true, pending: true, clockOffset: -60_000 },
])("runs owned shutdown hooks after $name output", async (entry) => {
  const { fail, json, pending, clockOffset = 0 } = entry;
  const root = tempDirs.make("openclaw-message-cleanup-");
  const pluginDir = path.join(root, "plugin");
  const marker = path.join(root, "stopped.txt");
  const clockPreload = path.join(root, "clock-step.mjs");
  if (clockOffset) {
    await fs.writeFile(
      clockPreload,
      `import fs from "node:fs";
const wallNow = Date.now.bind(Date);
Date.now = () => wallNow() + (fs.existsSync(${JSON.stringify(marker)}) ? ${clockOffset} : 0);
`,
    );
  }
  const fixture = createCliProcessFixture(root, {
    ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
    NODE_DISABLE_COMPILE_CACHE: "1",
    NO_COLOR: "1",
    NODE_OPTIONS: clockOffset ? `--import=${pathToFileURL(clockPreload).href}` : undefined,
  });
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
  await fixture.writeConfig({
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { load: { paths: [pluginDir] }, entries: { [id]: { enabled: true } } },
    channels: { [id]: { enabled: true } },
    logging: { level: "silent", consoleLevel: "silent" },
  });
  const args = ["message", "send", "--dry-run"];
  args.push("--channel", id, "--target", "user:synthetic");
  args.push("--media", mediaUrls[0], "--message", "Synthetic payload");
  args.push("--media", mediaUrls[1], ...(json ? ["--json"] : []));
  const result = await fixture.run(
    args,
    pending
      ? async (child) => {
          try {
            await waitForCliProcessStderrMarker(child, SHUTDOWN_WARNING);
            expect(child.exitCode).toBeNull();
          } finally {
            child.stdin.end();
          }
        }
      : undefined,
  );
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
  } else {
    expect(result.stderr).not.toContain(SHUTDOWN_WARNING);
  }
});
