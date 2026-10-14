import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginSetupModuleLoader } from "../plugins/plugin-setup-module.js";
import { loadBundledEntryExportSync } from "./channel-entry-contract.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

function fixture(reference: string) {
  const rootDir = temp.make("channel-companion-");
  const source = path.join(rootDir, "setup.cjs");
  const event = `companion:${rootDir}`;
  fs.writeFileSync(
    source,
    `
    const { fileURLToPath, pathToFileURL } = require('node:url');
    const sdk = require('openclaw/plugin-sdk/channel-entry-contract');
    const url = pathToFileURL(__filename).href;
    exports.root = __dirname;
    exports.default = sdk.defineBundledChannelSetupEntry({
      importMetaUrl: url,
      plugin: { specifier: ${reference}, exportName: 'plugin' },
    });
    exports.readLate = () => sdk.loadBundledEntryExportSync(url, { specifier: './late.cjs', exportName: 'value' });
  `,
  );
  fs.writeFileSync(
    path.join(rootDir, "helper.cjs"),
    `
    process.on(${JSON.stringify(event)}, () => {});
    exports.plugin = { id: 'fixture' };
  `,
  );
  const cache = createPluginCache();
  const record = {
    id: "fixture",
    origin: "global" as const,
    rootDir,
    source,
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    channels: [],
    providers: [],
    cliBackends: [],
    hooks: [],
    skills: [],
  };
  const loader = withPluginCache(cache, () => getPluginSetupModuleLoader(record, source, rootDir));
  const module = loader(source) as {
    root: string;
    default: { loadSetupPlugin(): { id: string } };
    readLate(): unknown;
  };
  return { cache, event, loader, module };
}

it.each(["'./helper.cjs'", "fileURLToPath(new URL('./helper.cjs', url).href)"])(
  "keeps SDK companion %s inside its captured owner",
  async (reference) => {
    const { cache, event, loader, module } = fixture(reference);
    try {
      expect(loader.initialize(() => module.default.loadSetupPlugin()).id).toBe("fixture");
      expect(process.listenerCount(event)).toBe(1);
      await retirePluginCache(cache);
      expect(() => module.default.loadSetupPlugin()).toThrow("reloaded or disabled");
      expect(process.listenerCount(event)).toBe(1);
    } finally {
      await retirePluginCache(cache);
      process.removeAllListeners(event);
    }
  },
);

it("rejects uncaptured SDK companions before consulting a shared native cache", async () => {
  const { cache, event, loader, module } = fixture("'./helper.cjs'");
  try {
    loader.initialize(() => module);
    fs.writeFileSync(path.join(module.root, "late.cjs"), "exports.value = 'late native bytes';");
    const url = pathToFileURL(path.join(module.root, "setup.cjs")).href;
    expect(
      withPluginCache(cache, () =>
        loadBundledEntryExportSync(url, {
          specifier: "./late.cjs",
          exportName: "value",
        }),
      ),
    ).toBe("late native bytes");
    expect(() => module.readLate()).toThrow(/captured/);
  } finally {
    await retirePluginCache(cache);
    process.removeAllListeners(event);
  }
});
