import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO, resetConfigRuntimeState, setRuntimeConfigSnapshot } from "./io.js";
import { createMergePatch, resolvePersistCandidateForWrite } from "./io.write-prepare.js";
import { applyMergePatch } from "./merge-patch.js";
import type { OpenClawConfig } from "./types.js";

// Catalog #17 / #5 — pinpoint where `acp.stream.deliveryMode: "live"` is lost
// across the openclaw config save/load/save cycle.
//
// Production symptom: `openclaw config set acp.stream.deliveryMode live`
// updates ~/.openclaw/openclaw.json correctly, but after `docker compose
// restart` the field is gone (jq -> null). The schema accepts it; the meta
// stamping path is benign (#9). The leading suspect is the merge-patch path
// in src/config/io.ts:~2412-2414 / io.write-prepare.ts:resolvePersistCandidateForWrite.
//
// These tests drive the cycle in isolation. RED today; the failing assertion
// pinpoints the loss site.

const silentLogger = {
  warn: () => {},
  error: () => {},
};

function makeAcpStreamConfig(): OpenClawConfig {
  return {
    gateway: { mode: "local" },
    acp: {
      stream: {
        deliveryMode: "live",
      },
    },
  };
}

describe("deliveryMode persistence (catalog #5/#17)", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-delivery-mode-persistence-",
  });

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return fn(home);
  }

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterEach(() => {
    resetConfigRuntimeState();
  });

  afterAll(async () => {
    resetConfigRuntimeState();
    await suiteRootTracker.cleanup();
  });

  describe("Path A.1 — unit-level merge-patch primitives", () => {
    // These probes pinpoint createMergePatch / applyMergePatch behavior
    // around the optional acp.stream.deliveryMode field.

    it("createMergePatch from base-with-deliveryMode to target-without omits acp (preservation fix)", () => {
      const base = makeAcpStreamConfig();
      const target: OpenClawConfig = { gateway: { mode: "local" } };

      const patch = createMergePatch(base, target);

      // After catalog #5/#17 fix: absent-in-target keys are skipped (not nulled).
      // The patch contains only the fields explicitly present in target; absent
      // keys are preserved when the patch is applied to the source config.
      expect((patch as Record<string, unknown>).acp).toBeUndefined();
    });

    it("applyMergePatch deletes acp when patch sets it to null", () => {
      const sourceWithDelivery = makeAcpStreamConfig();
      const patchNullingAcp = { acp: null };

      const result = applyMergePatch(sourceWithDelivery, patchNullingAcp) as OpenClawConfig;

      expect(result.acp).toBeUndefined();
      expect(result.gateway?.mode).toBe("local");
    });

    it("createMergePatch from runtime+target both containing deliveryMode produces no acp drop", () => {
      const base = makeAcpStreamConfig();
      const target = makeAcpStreamConfig();

      const patch = createMergePatch(base, target);
      // No acp drop expected — values are equal so should not appear.
      expect((patch as Record<string, unknown>).acp).toBeUndefined();
    });
  });

  describe("Path A.2 — resolvePersistCandidateForWrite simulating restart-then-write", () => {
    // Simulates the production sequence:
    //   1. operator sets deliveryMode=live -> file persisted with deliveryMode=live.
    //   2. gateway restart loads that file -> runtime snapshot is built.
    //   3. operator (or any internal write) issues an unrelated config edit
    //      that does NOT touch acp.stream. The runtime/source snapshot may
    //      have lost track of deliveryMode at some point in the load pipeline,
    //      so the merge-patch starts from a runtime snapshot lacking it.
    //   4. write merges patch back over source (which still had deliveryMode)
    //      -> if the patch nulls acp, acp is dropped.

    it("preserves deliveryMode when runtimeConfig and sourceConfig both have it (sanity)", () => {
      const persisted = resolvePersistCandidateForWrite({
        runtimeConfig: makeAcpStreamConfig(),
        sourceConfig: makeAcpStreamConfig(),
        nextConfig: {
          ...makeAcpStreamConfig(),
          gateway: { mode: "local", port: 18789 },
        },
      }) as OpenClawConfig;

      expect(persisted.acp?.stream?.deliveryMode).toBe("live");
      expect(persisted.gateway?.port).toBe(18789);
    });

    it("DROPS deliveryMode when nextConfig (caller intent) lacks acp.stream", () => {
      // This is the smoking-gun scenario: caller hands in a "narrow" config
      // that does not include acp at all; the merge-patch from runtime to
      // nextConfig nulls acp; applyMergePatch then deletes it from
      // projectedSource — even though the on-disk source still had it.
      const persisted = resolvePersistCandidateForWrite({
        runtimeConfig: makeAcpStreamConfig(),
        sourceConfig: makeAcpStreamConfig(),
        nextConfig: {
          gateway: { mode: "local", port: 18789 },
        },
      }) as OpenClawConfig;

      // Expected behavior (what the operator wants):
      //   deliveryMode survives a write that doesn't mention it.
      // Actual behavior today:
      //   acp is nulled by createMergePatch and deleted by applyMergePatch.
      expect(persisted.acp?.stream?.deliveryMode).toBe("live");
    });
  });

  describe("Path B — full file round-trip via createConfigIO", () => {
    // Drives the actual on-disk cycle:
    //   1. seed the file with deliveryMode=live (operator's `config set`).
    //   2. read it back via the IO load pipeline.
    //   3. assert load preserves deliveryMode.
    //   4. simulate restart by pinning a runtime snapshot derived from the
    //      loaded value, then issue a partial write that does NOT touch acp.
    //   5. read the persisted file and assert deliveryMode is still on disk.

    it("step 1+2: load preserves deliveryMode from disk into the runtime config", async () => {
      await withSuiteHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        const initialRaw = `${JSON.stringify(
          {
            gateway: { mode: "local" },
            acp: { stream: { deliveryMode: "live" } },
          },
          null,
          2,
        )}\n`;
        await fs.writeFile(configPath, initialRaw, "utf-8");

        const io = createConfigIO({
          configPath,
          env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });

        const loaded = io.loadConfig();
        const snapshot = await io.readConfigFileSnapshot();

        // Probe: load pipeline output (runtimeConfig + sourceConfig) for acp.stream.
        // If either is undefined here, the loss site is in the load pipeline,
        // not the write pipeline.
        expect(loaded.acp?.stream?.deliveryMode).toBe("live");
        expect(snapshot.runtimeConfig.acp?.stream?.deliveryMode).toBe("live");
        expect(snapshot.sourceConfig.acp?.stream?.deliveryMode).toBe("live");
      });
    });

    it("step 3+4+5: partial write after restart preserves deliveryMode on disk", async () => {
      await withSuiteHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        const initialRaw = `${JSON.stringify(
          {
            gateway: { mode: "local" },
            acp: { stream: { deliveryMode: "live" } },
          },
          null,
          2,
        )}\n`;
        await fs.writeFile(configPath, initialRaw, "utf-8");

        const io = createConfigIO({
          configPath,
          env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });

        // Simulate gateway startup: load + pin runtime snapshot like
        // the production code does so that subsequent writeConfigFile()
        // calls go through the runtime-snapshot merge-patch path.
        const loaded = io.loadConfig();
        const snapshot = await io.readConfigFileSnapshot();
        setRuntimeConfigSnapshot(loaded, snapshot.sourceConfig);

        // Operator does an unrelated edit (e.g., changing gateway port) that
        // does NOT touch acp.stream. The naive caller hands in just the changed
        // subtree — exactly as `openclaw config set gateway.port 18790` would.
        await io.writeConfigFile({
          gateway: { mode: "local", port: 18790 },
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;

        // Probe: persisted file content. If acp is missing here, the merge-patch
        // path stripped it. If it's present, the loss is elsewhere (not in this
        // narrow caller flow).
        expect(persisted.acp?.stream?.deliveryMode).toBe("live");
      });
    });

    it("step 3+4+5 alt: caller hands in the loaded config verbatim plus a single port edit", async () => {
      // This is a softer scenario: the caller carefully reuses the loaded
      // config and mutates only one field. If THIS still drops deliveryMode,
      // the loss is purely in the merge-patch direction (createMergePatch
      // sees the value in both base and target -> no patch -> survives).
      // If THIS preserves it, the loss is specifically in the "narrow caller"
      // flow tested above.
      await withSuiteHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        const initialRaw = `${JSON.stringify(
          {
            gateway: { mode: "local" },
            acp: { stream: { deliveryMode: "live" } },
          },
          null,
          2,
        )}\n`;
        await fs.writeFile(configPath, initialRaw, "utf-8");

        const io = createConfigIO({
          configPath,
          env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });

        const loaded = io.loadConfig();
        const snapshot = await io.readConfigFileSnapshot();
        setRuntimeConfigSnapshot(loaded, snapshot.sourceConfig);

        // Reuse loaded verbatim + mutate one field.
        await io.writeConfigFile({
          ...loaded,
          gateway: { ...loaded.gateway, port: 18790 },
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
        expect(persisted.acp?.stream?.deliveryMode).toBe("live");
      });
    });
  });
});
