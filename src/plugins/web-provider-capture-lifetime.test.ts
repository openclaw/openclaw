import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWebSearchTool } from "../agents/tools/web-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadOpenClawPlugins } from "./loader.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstanceDrainTimeoutError } from "./plugin-instance-error.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { clearActivePluginRegistry } from "./runtime.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each(["ordinary", "timed-out"] as const)(
  "retains a shared web search capture until concurrent %s calls return",
  async (kind) => {
    const root = temp.make("web-provider-custody-");
    const pluginRoot = path.join(root, "search-fixture");
    fs.mkdirSync(pluginRoot);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const event = `web-provider-custody:${root}`;
    const readEvent = `${event}:read`;
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "search-fixture",
        main: "index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "search-fixture",
        contracts: { webSearchProviders: ["fixture-search"] },
        configSchema: { type: "object", properties: {} },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.cjs"),
      `const fs = require("node:fs");
const filename = require("node:path").join(__dirname, "package.json");
module.exports = { id: "search-fixture", register(api) {
  api.registerWebSearchProvider({ id: "fixture-search", label: "Fixture", requiresCredential: false,
    hint: "fixture", envVars: [], placeholder: "", signupUrl: "https://example.com", credentialPath: "",
    getCredentialValue() {}, setCredentialValue() {},
    createTool() { return { description: "Fixture search", parameters: {}, async execute(args) {
      await new Promise(release => process.emit(${JSON.stringify(event)}, { filename, release }));
      const name = JSON.parse(fs.readFileSync(filename, "utf8")).name;
      process.emit(${JSON.stringify(readEvent)}, args.query);
      return { query: args.query, results: [{ title: name, url: "https://example.com", description: args.query }] };
    } }; }
  });
} };`,
    );
    const config: OpenClawConfig = {
      plugins: {
        load: { paths: [pluginRoot] },
        allow: ["search-fixture"],
        entries: { "search-fixture": { enabled: true } },
        slots: { memory: "none" },
      },
      tools: { web: { search: { provider: "fixture-search" } } },
    };
    const cache = createPluginCache();
    const registry = withPluginCache(cache, () => loadOpenClawPlugins({ config }));
    const record = expectDefined(
      registry.plugins.find((entry) => entry.id === "search-fixture"),
      "search plugin",
    );
    expect(record.status).toBe("loaded");
    const instance = expectDefined(getPluginInstance(record), "search plugin instance");
    const tool = expectDefined(createWebSearchTool({ config }), "web search tool");
    const readers: Array<{ filename: string; release: () => void }> = [];
    const entered = createDeferredCore();
    const captureReader = (reader: (typeof readers)[number]) => {
      readers.push(reader);
      if (readers.length === 50) {
        entered.resolve();
      }
    };
    process.on(event, captureReader);
    const completedReads: string[] = [];
    const captureRead = (query: string) => completedReads.push(query);
    process.on(readEvent, captureRead);
    const cancellation = vi.fn();
    instance.lifecycle.onDispose(cancellation);
    const calls = Promise.allSettled(
      Array.from({ length: 50 }, (_, index) =>
        tool.execute(`search-${index}`, { query: `query-${index}` }),
      ),
    );
    let retirement: ReturnType<typeof instance.dispose> | undefined;
    let physical: Promise<void> | undefined;
    try {
      await Promise.race([entered.promise, calls]);
      expect(readers).toHaveLength(50);
      expect(new Set(readers.map((reader) => reader.filename)).size).toBe(1);
      const filename = expectDefined(readers[0], "captured reader").filename;
      expect(filename).toContain("openclaw-plugin-build-");
      const remove = vi.spyOn(fsPromises, "rm");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      retirement = instance.dispose();
      await nextTurn();
      if (kind === "timed-out") {
        await vi.advanceTimersByTimeAsync(5_001);
        await nextTurn();
        const { errors } = await retirement;
        const timeout = errors[0];
        expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
        if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
          throw new Error("Expected forced retirement");
        }
        expect(timeout.forcedRetirement).toEqual({ activeCallCount: 50, retainedConsumerCount: 0 });
        physical = timeout.settled;
      }
      expect(cancellation).toHaveBeenCalledTimes(kind === "timed-out" ? 1 : 0);
      expect(instance.lifecycle.signal.aborted).toBe(kind === "timed-out");
      expect(() => instance.run(() => undefined)).toThrow("reloaded or disabled");
      expect(
        remove.mock.calls.filter(
          ([target]) => typeof target === "string" && filename.startsWith(target + path.sep),
        ),
      ).toHaveLength(0);
      expect(fs.existsSync(filename)).toBe(true);
      readers.forEach((reader) => reader.release());
      const outcomes = await calls;
      expect(completedReads.toSorted()).toEqual(
        Array.from({ length: 50 }, (_, index) => `query-${index}`).toSorted(),
      );
      expect(outcomes.map((result) => result.status)).toEqual(Array(50).fill("fulfilled"));
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status !== "fulfilled") {
          throw outcome.reason;
        }
        if (kind === "timed-out") {
          expect(outcome.value.details).toEqual({
            kind: "error",
            provider: "fixture-search",
            error: "provider_error",
            message: expect.stringContaining("Search failed"),
            docs: "https://docs.openclaw.ai/tools/web",
          });
        } else {
          expect(outcome.value.details).toMatchObject({
            kind: "results",
            provider: "fixture-search",
            query: `query-${index}`,
            count: 1,
            results: [
              { title: expect.stringContaining("search-fixture"), url: "https://example.com/" },
            ],
          });
        }
      }
      await retirement;
      await physical;
      expect(fs.existsSync(filename)).toBe(false);
    } finally {
      process.off(readEvent, captureRead);
      readers.forEach((reader) => reader.release());
      await calls;
      await retirement;
      await physical;
      await clearActivePluginRegistry();
      await retirePluginCache(cache);
      process.off(event, captureReader);
    }
  },
);
