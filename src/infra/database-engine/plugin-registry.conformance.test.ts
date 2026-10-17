import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configIO from "../../config/io.factory.js";
import { withPluginLifecycleLeaseAsync } from "../../plugins/plugin-lifecycle-lease.js";
import { readPluginMetadataStateRow } from "../../plugins/plugin-metadata-state-worker.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s post-ready plugin registry",
  (engine) => {
    const fixture = useMixedAgentPair(engine, engine);

    beforeEach(async () => {
      const configPath = path.join(fixture.root, "openclaw.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      await fs.writeFile(configPath, JSON.stringify({ ...config, plugins: { enabled: false } }));
    });

    it("publishes a durable registry with no PostgreSQL SQL on the main thread", async () => {
      const statements: unknown[] = [];
      const observation = channel("openclaw.database.statement");
      const observe = (event: unknown) => {
        if (
          event &&
          typeof event === "object" &&
          "engine" in event &&
          event.engine === "postgres"
        ) {
          statements.push(event);
        }
      };
      const warn = vi.fn();
      observation.subscribe(observe);
      try {
        await withPluginLifecycleLeaseAsync({ processBound: true }, (lease) =>
          refreshPluginRegistryAfterConfigMutation({
            reason: "source-changed",
            lease,
            installRecords: { retained: { source: "archive", version: "1.0.0" } },
            invalidateRuntimeCache: false,
            logger: { warn },
          }),
        );
        const row = await readPluginMetadataStateRow("installed-index", {});
        expect(row).toBeDefined();
        expect(JSON.parse(row!.value_json)).toMatchObject({
          index: {
            refreshReason: "source-changed",
            installRecords: { retained: { source: "archive", version: "1.0.0" } },
          },
        });
        expect(warn).not.toHaveBeenCalled();
        expect(statements).toEqual([]);
      } finally {
        observation.unsubscribe(observe);
      }
    });

    it("rejects authority lost during config preparation without replacing the durable registry", async () => {
      await withPluginLifecycleLeaseAsync({}, (lease) =>
        refreshPluginRegistryAfterConfigMutation({
          reason: "source-changed",
          lease,
          installRecords: { retained: { source: "archive", version: "1.0.0" } },
          invalidateRuntimeCache: false,
        }),
      );
      const before = await readPluginMetadataStateRow("installed-index", {});
      expect(before).toBeDefined();
      const refusal = new Error("Post-ready plugin owner revoked during config preparation");
      let current = true;
      const create = configIO.createConfigIO;
      vi.spyOn(configIO, "createConfigIO").mockImplementation((options) => {
        const io = create(options);
        return {
          ...io,
          readConfigFileSnapshot: async () => {
            const snapshot = await io.readConfigFileSnapshot();
            current = false;
            return snapshot;
          },
        };
      });
      const warn = vi.fn();
      await expect(
        withPluginLifecycleLeaseAsync(
          {
            processBound: true,
            assertCurrent: () => {
              if (!current) {
                throw refusal;
              }
            },
          },
          (lease) =>
            refreshPluginRegistryAfterConfigMutation({
              reason: "source-changed",
              lease,
              installRecords: { replacement: { source: "archive", version: "2.0.0" } },
              invalidateRuntimeCache: false,
              logger: { warn },
            }),
        ),
      ).rejects.toBe(refusal);
      expect(current).toBe(false);
      expect(await readPluginMetadataStateRow("installed-index", {})).toEqual(before);
      expect(warn).not.toHaveBeenCalled();
    });
  },
);
