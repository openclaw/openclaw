import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import { isPathInside } from "./path-safety.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const pluginId = "windows-sdk-consumer";
const sdkSpecifier = "openclaw/plugin-sdk/plugin-entry";
const relativeEntry = "./dist/index.mjs";

afterEach(() => vi.unstubAllEnvs());

function writeConsumer(root: string, events: string) {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: [relativeEntry], runtimeExtensions: [relativeEntry] },
    }),
  );
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  fs.writeFileSync(path.join(root, "dist", "value.mjs"), 'export const value = "fixture-value";');
  const entry = path.join(root, relativeEntry);
  fs.writeFileSync(
    entry,
    [
      'import { appendFileSync } from "node:fs";',
      'import { value } from "./value.mjs";',
      `import { definePluginEntry } from ${JSON.stringify(sdkSpecifier)};`,
      `const events = ${JSON.stringify(events)};`,
      `export default definePluginEntry({
        id: ${JSON.stringify(pluginId)},
        name: "Windows SDK consumer",
        description: "A local generation fixture",
        register(api) {
          appendFileSync(events, JSON.stringify({
            entry: import.meta.url,
            sdk: import.meta.resolve(${JSON.stringify(sdkSpecifier)}),
            value,
          }) + "\\n");
          api.lifecycle.onDispose(() => appendFileSync(events, "disposed\\n"));
        },
      });`,
    ].join("\n"),
  );
  return entry;
}

it.runIf(process.platform === "win32")(
  "registers and releases a managed plugin generation without a host SDK junction",
  async () => {
    const builtSdk = path.resolve(import.meta.dirname, "../../dist/plugin-sdk/plugin-entry.js");
    if (!fs.existsSync(builtSdk)) {
      throw new Error("Build the host SDK with pnpm build:runtime before running this Windows test.");
    }

    const root = temp.make("openclaw-windows-sdk-generation-");
    const captureRoot = path.join(root, "captures");
    fs.mkdirSync(captureRoot);
    const events = path.join(root, "events.log");
    const pluginRoot = path.join(root, "plugin");
    const sourceEntry = writeConsumer(pluginRoot, events);
    vi.stubEnv("CLAWCTL_GATEWAY_ISOLATION", "enabled");
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", undefined);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "state", "openclaw.json"));

    const inspection = await withPluginSourceCaptureDirectory(captureRoot, () =>
      acquirePluginRegistryForInspection({
        workspaceDir: root,
        onlyPluginIds: [pluginId],
        pluginSdkResolution: "dist",
        allowProcessHomeSessionCatalogs: false,
        config: {
          plugins: {
            enabled: true,
            load: { paths: [pluginRoot] },
            allow: [pluginId],
            entries: { [pluginId]: { enabled: true } },
          },
        },
      }),
    );

    try {
      const record = inspection.registry.plugins.find((plugin) => plugin.id === pluginId);
      expect(record?.error ?? null).toBeNull();
      expect(record?.status).toBe("loaded");

      const registrations = fs.readFileSync(events, "utf8").trimEnd().split("\n");
      expect(registrations).toHaveLength(1);
      const registration = JSON.parse(registrations[0]!) as {
        entry: string;
        sdk: string;
        value: string;
      };
      expect(registration.value).toBe("fixture-value");
      expect(fs.realpathSync(fileURLToPath(registration.sdk))).toBe(fs.realpathSync(builtSdk));

      const capturedEntry = fs.realpathSync(fileURLToPath(registration.entry));
      expect(isPathInside(captureRoot, capturedEntry)).toBe(true);
      expect(fs.readFileSync(capturedEntry, "utf8")).toBe(fs.readFileSync(sourceEntry, "utf8"));

      const [generation] = path.relative(captureRoot, capturedEntry).split(path.sep);
      const hostLink = path.join(captureRoot, generation!, "node_modules", "openclaw");
      // lstat also detects a junction whose target cannot be opened.
      expect(fs.lstatSync(hostLink, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      await inspection.release();
    }

    const lifecycle = fs.readFileSync(events, "utf8").trimEnd().split("\n");
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[1]).toBe("disposed");
    expect(fs.readdirSync(captureRoot)).toEqual([]);
  },
);
