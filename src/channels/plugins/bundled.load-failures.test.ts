import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.resetModules();
  vi.doUnmock("../../plugins/bundled-channel-runtime.js");
  vi.doUnmock("./bundled-root.js");
});

it("does not reevaluate a bundled source entry after an initialization error", async () => {
  const root = tempDirs.make("openclaw-bundled-source-error-");
  const pluginDir = path.join(root, "extensions", "alpha");
  const modulePath = path.join(pluginDir, "index.ts");
  const evaluationsPath = path.join(root, "evaluations.txt");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    modulePath,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(evaluationsPath)}, "evaluated\\n");`,
      'throw new Error("channel initialization failed");',
      "",
    ].join("\n"),
    "utf8",
  );
  vi.doMock("./bundled-root.js", () => ({
    resolveBundledChannelRootScope: () => ({ packageRoot: root, cacheKey: root }),
  }));
  vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
    listBundledChannelPluginMetadata: () => [
      {
        dirName: "alpha",
        rootDir: pluginDir,
        manifest: { id: "alpha", channels: ["alpha"] },
        source: { source: "./index.ts", built: "./index.ts" },
      },
    ],
    resolveBundledChannelGeneratedPath: () => modulePath,
  }));
  const bundled = await importFreshModule<typeof import("./bundled.js")>(
    import.meta.url,
    "./bundled.js?scope=bundled-source-initialization-error",
  );

  expect(bundled.getBundledChannelPlugin("alpha")).toBeUndefined();
  expect(bundled.getBundledChannelPlugin("alpha")).toBeUndefined();
  expect(fs.readFileSync(evaluationsPath, "utf8")).toBe("evaluated\n");
});
