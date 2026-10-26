import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import { replaceConfigFile, type ConfigMutationIO } from "./mutate.js";
import { createSnapshot } from "./mutate.test-support.js";
import { getResolvedConfigEnvSecretRef } from "./resolution-facts.js";
import {
  registerManagedRuntimeConfigWriteOwner,
  registerRuntimeConfigWriteListener,
  type RuntimeConfigWriteNotification,
  type RuntimeConfigWritePreparedCandidate,
} from "./runtime-snapshot.js";
import { withTempHomeConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}
beforeEach(resetRuntimeConfigState);
afterEach(resetRuntimeConfigState);

it.each(["root", "include"])("publishes managed %s writes with auth-store scope", async (mode) => {
  const include = mode === "include";
  const initial: OpenClawConfig = include
    ? { plugins: { entries: {} } }
    : {
        env: { vars: { CONFIG_PUBLICATION_BIN: "jq" } },
        gateway: { mode: "local" },
        logging: { level: "info" },
        tools: { exec: { safeBins: ["jq"] } },
      };
  const authoredTools = { exec: { safeBins: ["${CONFIG_PUBLICATION_BIN}"] } };
  const authored = include
    ? { plugins: { $include: "./config/plugins.json5" } }
    : { ...initial, tools: { $include: "./tools.json5" } };
  await withTempHomeConfig(authored, async ({ configPath: file }) => {
    const includeFile = path.join(
      path.dirname(file),
      include ? "config/plugins.json5" : "tools.json5",
    );
    await fs.mkdir(path.dirname(includeFile), { recursive: true });
    await fs.writeFile(
      includeFile,
      JSON.stringify(include ? { entries: {} } : authoredTools),
      "utf-8",
    );
    const raw = await fs.readFile(file, "utf-8");
    const snapshot = createSnapshot({
      path: file,
      hash: hashConfigRaw(raw),
      parsed: authored,
      sourceConfig: initial,
      raw,
    });
    const next: OpenClawConfig = include
      ? { plugins: { entries: { demo: { enabled: true } } } }
      : { ...initial, logging: { level: "debug" } };
    const runtime: OpenClawConfig = include ? { ...next, logging: { level: "debug" } } : next;
    const metadata = Symbol("prepared metadata");
    let prepared: (RuntimeConfigWritePreparedCandidate & { [metadata]: string }) | undefined;
    const preflight = async (
      source: OpenClawConfig,
      options?: { includeAuthStoreRefs?: boolean },
    ) => {
      if (options?.includeAuthStoreRefs !== false) {
        throw new Error("unavailable auth-profile SecretRef");
      }
      return (prepared = {
        runtimeConfig: include ? snapshot.runtimeConfig : source,
        compareConfig: include ? snapshot.sourceConfig : source,
        [metadata]: "preserved",
        reapplyRuntimeOverlays(config) {
          expect(this).toBe(prepared);
          return { ...config, logging: { level: "warn" } };
        },
        reapplyCompareOverlays(config) {
          expect(this).toBe(prepared);
          return { ...config, logging: { level: "error" } };
        },
      });
    };
    const fallback = {
      runtimeConfig: snapshot.runtimeConfig,
      compareConfig: snapshot.sourceConfig,
    };
    const owner = include ? registerManagedRuntimeConfigWriteOwner(file, preflight) : undefined;
    const backup = include
      ? registerManagedRuntimeConfigWriteOwner(file, async () => fallback)
      : undefined;
    const events: RuntimeConfigWriteNotification[] = [];
    const record = (event: RuntimeConfigWriteNotification) => {
      if (event.configPath === file) {
        events.push(event);
      }
    };
    const stop = include
      ? registerRuntimeConfigWriteListener(record)
      : registerConfigWriteListener(record, {
          ownsRuntimeActivationFor: file,
          preCommitRuntimePreflight: preflight,
        });
    try {
      if (include) {
        // Only the reread is controlled; include containment, hashing and writes are real.
        const io = {
          readConfigFileSnapshotForWrite: async () => ({
            snapshot: { ...snapshot, sourceConfig: next, runtimeConfig: runtime, config: runtime },
            writeOptions: { expectedConfigPath: file },
          }),
          writeConfigFile: vi.fn<ConfigMutationIO["writeConfigFile"]>(),
        } satisfies ConfigMutationIO;
        await replaceConfigFile({
          baseHash: snapshot.hash ?? undefined,
          snapshot,
          writeOptions: {
            expectedConfigPath: file,
            assertConfigPathForWrite: () => {},
            includeFileTargetsForWrite: { [includeFile]: await fs.realpath(includeFile) },
            runtimeRefresh: { includeAuthStoreRefs: false },
          },
          nextConfig: next,
          io,
        });
        expect(io.writeConfigFile).not.toHaveBeenCalled();
      } else {
        setRuntimeConfigSnapshot(initial, initial);
        await writeConfigFile(next, { runtimeRefresh: { includeAuthStoreRefs: false } });
      }
    } finally {
      stop();
      backup?.();
      owner?.();
    }
    expect(events).toHaveLength(1);
    const [event] = events;
    const candidates = event?.preparedCandidatesByOwner;
    expect(event?.runtimeRefresh).toEqual({ includeAuthStoreRefs: false });
    expect(event?.snapshot).toMatchObject({ path: file, sourceConfig: next });
    const projected = owner ? candidates?.get(owner.ownerId) : event?.preparedCandidate;
    expect(projected).toMatchObject({
      runtimeConfig: { ...runtime, logging: { level: "warn" } },
      compareConfig: { ...next, logging: { level: "error" } },
    });
    if (include) {
      expect(event?.snapshot).toMatchObject({ raw, parsed: authored, runtimeConfig: runtime });
      expect(projected).toMatchObject({ [metadata]: "preserved" });
      expect(prepared?.runtimeConfig).toBe(snapshot.runtimeConfig);
      expect(prepared?.compareConfig).toBe(snapshot.sourceConfig);
      const unchanged = backup && candidates?.get(backup.ownerId);
      expect(unchanged?.runtimeConfig).toBe(fallback.runtimeConfig);
      expect(unchanged?.compareConfig).toBe(fallback.compareConfig);
      expect(JSON.parse(await fs.readFile(includeFile, "utf-8"))).toMatchObject({
        entries: { demo: { enabled: true } },
      });
      await expect(fs.readFile(file, "utf-8")).resolves.toBe(raw);
    } else {
      expect(event?.snapshot).toMatchObject({
        parsed: { tools: { $include: "./tools.json5" } },
        authoredConfig: { tools: authoredTools },
        includeProvenance: expect.arrayContaining([
          expect.objectContaining({ path: ["tools"], kind: "single", targetPath: includeFile }),
        ]),
        hash: event?.persistedHash,
      });
      expect(event?.snapshot.raw).toBe(await fs.readFile(file, "utf-8"));
      expect(
        getResolvedConfigEnvSecretRef(event?.snapshot.sourceConfig, "tools.exec.safeBins[0]"),
      ).toEqual({ source: "env", provider: "default", id: "CONFIG_PUBLICATION_BIN" });
      expect(prepared?.runtimeConfig.logging?.level).toBe("debug");
      expect(prepared?.compareConfig.logging?.level).toBe("debug");
    }
  });
});
