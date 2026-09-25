// Config RPCs cover control-UI edits, secrets, auth persistence, and rate limiting.
import { randomUUID } from "node:crypto";
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { applyLoggingConfig } from "../logging/logger.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { deleteTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";
import { registerAgentConfigMutationTests } from "./server.config-agent-mutations.test-support.js";
import {
  configRawPayload,
  configWithGatewayTokenSecretRef,
  makeRouteBinding,
  withConfigFileFixture,
} from "./server.config-patch.test-support.js";
import {
  configRpcWorkspacePath,
  getConfigHash,
  getCurrentConfigObject,
  installConfigWriteGatewayHooks,
  installReadOnlyConfigGatewayHooks,
  installSharedConfigWriteGatewayHooks,
  requireClient,
  requireConfigObject,
  resetTempDir,
  restoreConfigFileForTest,
  rpcReq,
  sendConfigApply,
  sendConfigSet,
  writeJsonFile,
  writeUnresolvedAuthProfileTokenRef,
} from "./server.config-rpc-gateway.test-support.js";

const reloadBarrier = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined }));

vi.mock("./config-reload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config-reload.js")>();
  return {
    ...actual,
    startGatewayConfigReloader: (
      options: Parameters<typeof actual.startGatewayConfigReloader>[0],
    ) =>
      actual.startGatewayConfigReloader({
        ...options,
        onHotReload: async (...args) => {
          await reloadBarrier.wait;
          return await options.onHotReload(...args);
        },
      }),
  };
});

const CONFIG_SECRETREF_RPC_TIMEOUT_MS = 20_000;

describe("gateway config methods", () => {
  installConfigWriteGatewayHooks();

  it("reloads owners independently and reports a changed unresolved owner as cold", async () => {
    const original = await getCurrentConfigObject();
    const secretFile = path.join(await resetTempDir("owner-reload"), "secrets.json");
    await writeJsonFile(secretFile, { first: "first-old", second: "second-old" });
    await fs.chmod(secretFile, 0o600);
    const ref = (id: string) => ({ source: "file", provider: "reload-proof", id });
    const providerConfig = {
      secrets: {
        providers: {
          "reload-proof": { source: "file", path: secretFile, mode: "json" },
        },
      },
      models: {
        providers: {
          "reload-first": {
            apiKey: ref("/first"),
            baseUrl: "https://first.example.invalid/v1",
            models: [],
          },
          "reload-second": {
            apiKey: ref("/second"),
            baseUrl: "https://second.example.invalid/v1",
            models: [],
          },
        },
      },
    };

    try {
      const seed = await rpcReq<{ degradedSecretOwners?: unknown[] }>(
        requireClient(),
        "config.patch",
        {
          raw: JSON.stringify(providerConfig),
          baseHash: original.hash,
        },
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(seed.ok, seed.error?.message).toBe(true);
      expect(seed.payload?.degradedSecretOwners).toBeUndefined();

      await writeJsonFile(secretFile, { second: "second-new" });
      await fs.chmod(secretFile, 0o600);
      const reload = await rpcReq<{ warningCount?: number }>(
        requireClient(),
        "secrets.reload",
        {},
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(reload.ok).toBe(true);
      const stale = getActiveSecretsRuntimeSnapshot();
      expect(stale?.config.models?.providers?.["reload-first"]?.apiKey).toBe("first-old");
      expect(stale?.config.models?.providers?.["reload-second"]?.apiKey).toBe("second-new");
      expect(stale?.degradedOwners).toMatchObject([
        { ownerKind: "provider", ownerId: "reload-first", degradationState: "stale" },
      ]);

      const beforeCold = await getCurrentConfigObject();
      const cold = await rpcReq<{
        degradedSecretOwners?: Array<{ ownerId?: string; state?: string }>;
      }>(
        requireClient(),
        "config.patch",
        {
          raw: JSON.stringify({
            models: {
              providers: {
                "reload-first": { apiKey: ref("/changed") },
              },
            },
          }),
          baseHash: beforeCold.hash,
        },
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(cold.ok).toBe(true);
      expect(cold.payload?.degradedSecretOwners).toEqual([
        expect.objectContaining({ ownerId: "reload-first", state: "cold" }),
      ]);
      const coldSnapshot = getActiveSecretsRuntimeSnapshot();
      expect(coldSnapshot?.config.models?.providers?.["reload-first"]?.apiKey).toEqual(
        ref("/changed"),
      );
      expect(coldSnapshot?.config.models?.providers?.["reload-second"]?.apiKey).toBe("second-new");
    } finally {
      await restoreConfigFileForTest(original);
      activateSecretsRuntimeSnapshot(
        await prepareSecretsRuntimeSnapshot({
          config: original.config,
          includeAuthStoreRefs: true,
        }),
      );
    }
  });
});

describe("gateway config methods", () => {
  installConfigWriteGatewayHooks({ watchConfigFiles: false });

  it.each(["config.patch", "config.set", "config.apply"])(
    "%s rejects an include-only stale draft and accepts a reloaded draft",
    async (method) => {
      const original = await getCurrentConfigObject();
      const includePath = path.join(path.dirname(original.path), "logging.json5");
      await writeJsonFile(includePath, { level: "info" });
      const root = { ...original.config, logging: { $include: "./logging.json5" } };
      await writeJsonFile(original.path, root);
      // Finish fixture seeding before warming the draft whose rejection must invalidate reads.
      invalidateConfigGetResponseCache();
      const draft = await getCurrentConfigObject();
      expect(draft.config.logging).toEqual({ level: "info" });
      const raw = JSON.stringify(
        method === "config.patch"
          ? { logging: { level: "debug" } }
          : { ...draft.config, logging: { level: "debug" } },
      );
      await writeJsonFile(includePath, { level: "warn" });

      const stale = await rpcReq(requireClient(), method, { raw, baseHash: draft.hash });

      expect(stale.ok).toBe(false);
      expect(stale.error?.message).toContain("config changed since last load");
      expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({ level: "warn" });
      const refreshedHash = await getConfigHash();
      expect(refreshedHash).not.toBe(draft.hash);
      const fresh = await rpcReq<{ hash: string }>(requireClient(), method, {
        raw,
        baseHash: refreshedHash,
      });
      expect(fresh.ok, fresh.error?.message).toBe(true);
      expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({ level: "debug" });
      expect(JSON.parse(await fs.readFile(original.path, "utf8"))).toEqual(root);
      expect(await getConfigHash()).toBe(fresh.payload?.hash);
    },
  );
});

describe("gateway config methods", () => {
  installConfigWriteGatewayHooks();

  it.each(["plain", "unrelated-include", "include-only"] as const)(
    "openclaw.changes.list preserves an approved %s operation without a duplicate write",
    async (layout) => {
      const { executeSystemAgentOperation } = await import("../system-agent/operations.js");
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const original = await getCurrentConfigObject();
      const model = "openai/gpt-4.1-mini";
      const agents = {
        entries: { main: { default: true } },
        defaults: { model: { primary: "openai/gpt-4.1" } },
      };
      const includePath = path.join(path.dirname(original.path), "audit-include.json");
      await writeJsonFile(includePath, layout === "include-only" ? agents : { level: "info" });
      const root = {
        ...original.config,
        agents: layout === "include-only" ? { $include: "./audit-include.json" } : agents,
        ...(layout === "unrelated-include"
          ? { logging: { $include: "./audit-include.json" } }
          : {}),
      };
      await writeJsonFile(original.path, root);
      const rootBefore = await fs.readFile(original.path, "utf8");
      const includeBefore = await fs.readFile(includePath, "utf8");
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      // Only inference is supplied: config reads, approved writes, and both journals are real.
      const result = await executeSystemAgentOperation(
        { kind: "set-default-model", model },
        runtime,
        {
          approved: true,
          deps: {
            verifyInferenceConfig: async () => ({ ok: true, modelRef: model, latencyMs: 1 }),
          },
        },
      );
      expect(result).toEqual({ applied: true });
      expect(runtime.error).not.toHaveBeenCalled();
      expect((await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model).toEqual({
        primary: model,
      });
      const history = await rpcReq<{
        entries: Array<{ kind: string; source: string; summary: string; changedPaths?: string[] }>;
      }>(requireClient(), "openclaw.changes.list", { limit: 100 });
      expect(history.ok).toBe(true);
      const operations = history.payload?.entries.filter((entry) => entry.kind === "operation");
      expect.soft(operations).toEqual([
        expect.objectContaining({
          source: "system-agent",
          summary: `Set default model to ${model}`,
          ...(layout === "include-only"
            ? {}
            : { changedPaths: expect.arrayContaining(["agents.defaults.model.primary"]) }),
        }),
      ]);
      expect(history.payload?.entries.filter((entry) => entry.kind === "config-write")).toEqual([]);
      if (layout === "include-only") {
        expect(await fs.readFile(original.path, "utf8")).toBe(rootBefore);
        expect(operations?.[0]?.changedPaths).toBeUndefined();
      } else {
        expect(await fs.readFile(includePath, "utf8")).toBe(includeBefore);
      }
    },
  );
});

describe("gateway config methods", () => {
  installSharedConfigWriteGatewayHooks({
    fixturePaths: ["logging.json", "logging-first", "logging-second", "logging-current"],
  });

  it.each([
    ...(["EPERM", "EEXIST"] as const).flatMap((code) =>
      (["unchanged", "changed"] as const).flatMap((includedContent) =>
        (["retained", "deleted"] as const).map((rootState) => ({
          code,
          includedContent,
          rootState,
        })),
      ),
    ),
    ...(["EPERM", "EEXIST"] as const).map((code) => ({
      code,
      includedContent: "changed" as const,
      rootState: "removed-by-writer" as const,
    })),
  ])(
    "config.set handles $code copy fallback with $includedContent included content and $rootState root",
    async ({ code, includedContent, rootState }) => {
      const original = await getCurrentConfigObject();
      const includePath = path.join(path.dirname(original.path), "logging.json");
      await writeJsonFile(includePath, { level: "info" });
      await writeJsonFile(original.path, {
        ...original.config,
        logging: { $include: "logging.json" },
        gateway: { reload: { mode: "off" } },
      });
      invalidateConfigGetResponseCache();
      const draft = await getCurrentConfigObject();
      const rootBefore = await fs.readFile(original.path, "utf8");
      const rename = fsNode.renameSync;
      let renameDenied = false;
      vi.spyOn(fsNode, "renameSync").mockImplementation((source, destination) => {
        if (destination !== original.path) {
          return rename(source, destination);
        }
        renameDenied = true;
        if (rootState === "deleted") {
          fsNode.unlinkSync(original.path);
        }
        if (includedContent === "changed" && rootState !== "removed-by-writer") {
          fsNode.writeFileSync(includePath, JSON.stringify({ level: "debug" }));
        }
        throw Object.assign(new Error("rename denied"), { code });
      });
      if (rootState === "removed-by-writer") {
        const remove = fsNode.rmSync;
        vi.spyOn(fsNode, "rmSync").mockImplementation((filePath, options) => {
          remove(filePath, options);
          if (filePath === original.path) {
            fsNode.writeFileSync(includePath, JSON.stringify({ level: "debug" }));
          }
        });
      }

      const result = await rpcReq(requireClient(), "config.set", {
        raw: JSON.stringify({ ...draft.config, ui: { prefs: { locale: "fr" } } }),
        baseHash: draft.hash,
      });

      expect(renameDenied).toBe(true);
      if (includedContent === "changed" || rootState === "deleted") {
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe(
          rootState === "removed-by-writer" ? "UNAVAILABLE" : "INVALID_REQUEST",
        );
        expect(result.error?.message).toContain(
          includedContent === "changed" ? "included config" : "config changed since last load",
        );
        if (rootState === "deleted") {
          await expect(fs.stat(original.path)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(original.path, "utf8")).toBe(rootBefore);
        }
        if (rootState === "removed-by-writer") {
          expect(result.error?.message).toContain("The config write was rolled back.");
          expect(result.error?.message).toContain(
            `Inspect recovery backups at ${original.path}.bak.`,
          );
          expect(await fs.readFile(`${original.path}.bak`, "utf8")).toBe(rootBefore);
        }
        expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({
          level: includedContent === "changed" ? "debug" : "info",
        });
      } else {
        expect(result.ok, result.error?.message).toBe(true);
        invalidateConfigGetResponseCache();
        const committed = await getCurrentConfigObject();
        expect(result.payload).toMatchObject({ config: committed.config, hash: committed.hash });
        expect(committed.config).toMatchObject({
          logging: { level: "info" },
          ui: { prefs: { locale: "fr" } },
        });
        expect(JSON.parse(await fs.readFile(original.path, "utf8"))).toMatchObject({
          logging: { $include: "logging.json" },
        });
        expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({ level: "info" });
      }
    },
  );

  it.each(["content", "target", "missing"] as const)(
    "config.set rejects include %s changes during runtime preflight before committing",
    async (change) => {
      const configFactory = await import("../config/io.factory.js");
      const original = await getCurrentConfigObject();
      const directory = path.dirname(original.path);
      const first = path.join(directory, "logging-first");
      const second = path.join(directory, "logging-second");
      const current = path.join(directory, "logging-current");
      await fs.mkdir(first);
      await fs.mkdir(second);
      await writeJsonFile(path.join(first, "logging.json"), { level: "info" });
      await writeJsonFile(path.join(second, "logging.json"), { level: "info" });
      await fs.symlink(first, current, "junction");
      await writeJsonFile(original.path, {
        ...original.config,
        logging: { $include: "logging-current/logging.json" },
        gateway: { reload: { mode: "off" } },
      });
      invalidateConfigGetResponseCache();
      const draft = await getCurrentConfigObject();
      const rootBefore = await fs.readFile(original.path, "utf8");
      const createIO = configFactory.createConfigIO;
      vi.spyOn(configFactory, "createConfigIO").mockImplementation((options) => {
        const io = createIO(options);
        return {
          ...io,
          writeConfigFile: (config, writeOptions) =>
            io.writeConfigFile(config, {
              ...writeOptions,
              preCommitRuntimePreflight: async (source) => {
                await writeOptions?.preCommitRuntimePreflight?.(source);
                if (change === "content") {
                  await writeJsonFile(path.join(first, "logging.json"), { level: "debug" });
                } else if (change === "missing") {
                  await fs.unlink(path.join(first, "logging.json"));
                } else {
                  await fs.unlink(current);
                  await fs.symlink(second, current, "junction");
                }
              },
            }),
        };
      });

      const result = await rpcReq(requireClient(), "config.set", {
        raw: JSON.stringify({ ...draft.config, ui: { prefs: { locale: "fr" } } }),
        baseHash: draft.hash,
      });

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("included config");
      expect(await fs.readFile(original.path, "utf8")).toBe(rootBefore);
      if (change === "missing") {
        await expect(fs.readFile(path.join(current, "logging.json"), "utf8")).rejects.toMatchObject(
          {
            code: "ENOENT",
          },
        );
      } else {
        expect(JSON.parse(await fs.readFile(path.join(current, "logging.json"), "utf8"))).toEqual({
          level: change === "content" ? "debug" : "info",
        });
      }
      expect(await fs.realpath(current)).toBe(
        await fs.realpath(change === "target" ? second : first),
      );
    },
  );

  it("config.set acknowledges an include config when an external edit invalidates the reread", async () => {
    const configFactory = await import("../config/io.factory.js");
    const original = await getCurrentConfigObject();
    await writeJsonFile(path.join(path.dirname(original.path), "logging.json"), { level: "info" });
    await writeJsonFile(original.path, {
      ...original.config,
      logging: { $include: "logging.json" },
      gateway: { reload: { mode: "off" } },
    });
    invalidateConfigGetResponseCache();
    const draft = await getCurrentConfigObject();
    let committed: Awaited<ReturnType<typeof getCurrentConfigObject>> | undefined;
    const createIO = configFactory.createConfigIO;
    vi.spyOn(configFactory, "createConfigIO").mockImplementation((options) => {
      const io = createIO(options);
      return {
        ...io,
        writeConfigFile: async (...args) => {
          const written = await io.writeConfigFile(...args);
          if (io.configPath === original.path) {
            invalidateConfigGetResponseCache();
            committed = await getCurrentConfigObject();
            await fs.writeFile(original.path, "{ external editor incomplete\n");
          }
          return written;
        },
      };
    });
    const result = await rpcReq(requireClient(), "config.set", {
      raw: JSON.stringify({ ...draft.config, ui: { prefs: { locale: "fr" } } }),
      baseHash: draft.hash,
    });
    expect(result.ok, result.error?.message).toBe(true);
    expect(committed?.config).toMatchObject({ logging: { level: "info" } });
    expect(result.payload).toMatchObject({ config: committed?.config, hash: committed?.hash });
    expect(await fs.readFile(original.path, "utf8")).toBe("{ external editor incomplete\n");
  });

  it("config.set pairs the committed config and revision while another writer waits", async () => {
    const configFactory = await import("../config/io.factory.js");
    const { KeyedAsyncQueue } = await import("../plugin-sdk/keyed-async-queue.js");
    const original = await getCurrentConfigObject();
    await writeJsonFile(original.path, {
      ...original.config,
      gateway: {
        ...requireConfigObject(original.config.gateway ?? {}, "gateway config"),
        reload: { mode: "off" },
      },
    });
    invalidateConfigGetResponseCache();
    const draft = await getCurrentConfigObject();
    const canonicalRead = createDeferredCore();
    const releaseCanonicalRead = createDeferredCore();
    const competingLock = createDeferredCore();
    let pauseCanonicalRead = true;
    let observeCompetingLock = false;
    let competingWriterStarted = false;
    const createIO = configFactory.createConfigIO;
    // oxlint-disable-next-line typescript/unbound-method -- The observer calls the original with its queue receiver.
    const enqueue = KeyedAsyncQueue.prototype.enqueue;

    // Retain real IO and locks; pause only the committed writer return so the
    // competing authenticated request has a deterministic contention window.
    const ioObservation = vi
      .spyOn(configFactory, "createConfigIO")
      .mockImplementation((options) => {
        const io = createIO(options);
        return {
          ...io,
          writeConfigFile: async (...args) => {
            const written = await io.writeConfigFile(...args);
            if (io.configPath === original.path && pauseCanonicalRead) {
              pauseCanonicalRead = false;
              canonicalRead.resolve();
              await releaseCanonicalRead.promise;
            }
            return written;
          },
        };
      });
    const lockObservation = vi
      .spyOn(KeyedAsyncQueue.prototype, "enqueue")
      .mockImplementation(function <T>(
        this: InstanceType<typeof KeyedAsyncQueue>,
        ...args: Parameters<typeof enqueue<T>>
      ): Promise<T> {
        const enqueueTask = enqueue<T>;
        if (args[0] !== original.path || !observeCompetingLock) {
          return enqueueTask.call(this, ...args);
        }
        observeCompetingLock = false;
        const [lockPath, write, hooks] = args;
        const waiting = enqueueTask.call(
          this,
          lockPath,
          async () => {
            competingWriterStarted = true;
            return await write();
          },
          hooks,
        );
        competingLock.resolve();
        return waiting;
      });
    type Receipt = { config: Record<string, unknown>; hash: string };
    const pending: Array<ReturnType<typeof rpcReq<Receipt>>> = [];
    try {
      const first = rpcReq<Receipt>(requireClient(), "config.set", {
        raw: JSON.stringify({ ...draft.config, logging: { level: "debug" } }),
        baseHash: draft.hash,
      });
      pending.push(first);
      await withTestTimeout(
        Promise.race([
          canonicalRead.promise,
          first.then(() => {
            throw new Error("write settled before its canonical receipt read");
          }),
        ]),
        2_000,
        "root write did not reach its canonical receipt read",
      );

      // An external editor need not take the config lock. Make the receipt
      // distinguishable from both the submitted config and the writer result.
      const written = JSON.parse(await fs.readFile(original.path, "utf8"));
      expect(written.logging.level).toBe("debug");
      invalidateConfigGetResponseCache();
      const committed = await getCurrentConfigObject();
      await writeJsonFile(original.path, { ...written, ui: { prefs: { locale: "fr" } } });
      invalidateConfigGetResponseCache();
      const canonical = await getCurrentConfigObject();
      expect(canonical.config).toMatchObject({
        logging: { level: "debug" },
        ui: { prefs: { locale: "fr" } },
      });

      observeCompetingLock = true;
      const second = rpcReq<Receipt>(requireClient(), "config.set", {
        raw: JSON.stringify({
          ...canonical.config,
          logging: { level: "debug", consoleLevel: "warn" },
        }),
        baseHash: canonical.hash,
      });
      pending.push(second);
      await withTestTimeout(
        Promise.race([
          competingLock.promise,
          second.then(() => {
            throw new Error("competing write settled without waiting on the config lock");
          }),
        ]),
        2_000,
        "competing write did not attempt the config lock",
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(competingWriterStarted).toBe(false);
      // Exclude the deliberate pause and external-editor fixture IO from completion latency.
      const completionStarted = performance.now();
      releaseCanonicalRead.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      const completionMs = performance.now() - completionStarted;
      expect(completionMs).toBeLessThan(2_000);
      expect(firstResult.ok, firstResult.error?.message).toBe(true);
      expect(secondResult.ok, secondResult.error?.message).toBe(true);
      expect(competingWriterStarted).toBe(true);
      expect({ config: firstResult.payload?.config, hash: firstResult.payload?.hash }).toEqual({
        config: committed.config,
        hash: committed.hash,
      });
      const after = await getCurrentConfigObject();
      expect({ config: secondResult.payload?.config, hash: secondResult.payload?.hash }).toEqual({
        config: after.config,
        hash: after.hash,
      });
      expect(after.hash).not.toBe(canonical.hash);
      expect(JSON.parse(await fs.readFile(original.path, "utf8"))).toMatchObject({
        logging: { level: "debug", consoleLevel: "warn" },
        ui: { prefs: { locale: "fr" } },
      });
    } finally {
      releaseCanonicalRead.resolve();
      await Promise.allSettled(pending);
      ioObservation.mockRestore();
      lockObservation.mockRestore();
      await restoreConfigFileForTest(original);
      invalidateConfigGetResponseCache();
    }
  });
});

describe("gateway config methods", () => {
  installConfigWriteGatewayHooks();

  registerAgentConfigMutationTests({
    getCurrentConfigObject,
    getConfigHash,
    rpc: (method, params) => rpcReq(requireClient(), method, params),
    workspacePath: configRpcWorkspacePath,
    reloadBarrier,
  });
});

describe("gateway config methods", () => {
  installSharedConfigWriteGatewayHooks();

  it("round-trips config.set and returns the live config path", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const current = await getCurrentConfigObject();

    const res = await rpcReq<{
      ok?: boolean;
      path?: string;
      hash?: string;
      config?: Record<string, unknown>;
    }>(requireClient(), "config.set", {
      ...configRawPayload(current.config, current.hash),
    });

    expect(res.ok, res.error?.message).toBe(true);
    expect(res.payload?.path).toBe(createConfigIO().configPath);
    requireConfigObject(res.payload?.config, "updated config");
    expect(res.payload?.hash).toBe(await getConfigHash());
  });

  it.each([
    { change: "deletes an earlier mapping", ids: ["bravo"], unidentifiedFirst: false },
    { change: "reorders existing mappings", ids: ["bravo", "alpha"], unidentifiedFirst: false },
    { change: "deletes an earlier unidentified mapping", ids: ["bravo"], unidentifiedFirst: true },
  ])(
    "keeps redacted hook secrets with their owner when config.set $change",
    async ({ ids, unidentifiedFirst }) => {
      const original = await getCurrentConfigObject();
      const configured = structuredClone(original.config);
      configured.hooks = {
        ...requireConfigObject(configured.hooks ?? {}, "original hooks config"),
        mappings: [
          {
            ...(unidentifiedFirst ? {} : { id: "alpha" }),
            sessionKey: "synthetic-alpha-session",
          },
          { id: "bravo", sessionKey: "synthetic-bravo-session" },
        ],
      };

      try {
        await writeJsonFile(original.path, configured);
        invalidateConfigGetResponseCache();
        const current = await getCurrentConfigObject();
        const visibleHooks = requireConfigObject(current.config.hooks, "redacted hooks config");
        const visibleMappings = visibleHooks.mappings as Array<{
          id: string;
          sessionKey: string;
        }>;
        expect(visibleMappings.map((mapping) => mapping.sessionKey)).toEqual([
          REDACTED_SENTINEL,
          REDACTED_SENTINEL,
        ]);

        const submitted = structuredClone(current.config);
        const submittedHooks = requireConfigObject(submitted.hooks, "submitted hooks config");
        submittedHooks.mappings = ids.map((id) =>
          visibleMappings.find((mapping) => mapping.id === id),
        );

        const response = await sendConfigSet(configRawPayload(submitted, current.hash));

        expect(response.error).toBeUndefined();
        expect(response.ok).toBe(true);
        expect(JSON.stringify(response.payload)).not.toContain("synthetic-alpha-session");
        expect(JSON.stringify(response.payload)).not.toContain("synthetic-bravo-session");
        const persisted = JSON.parse(await fs.readFile(original.path, "utf-8")) as {
          hooks?: { mappings?: Array<{ id: string; sessionKey: string }> };
        };
        expect(persisted.hooks?.mappings).toEqual(
          ids.map((id) => ({ id, sessionKey: `synthetic-${id}-session` })),
        );
      } finally {
        await restoreConfigFileForTest(original);
        invalidateConfigGetResponseCache();
      }
    },
  );

  it("accepts config.set when the submitted roster keeps every agent entry", async () => {
    const original = await getCurrentConfigObject();
    const rosterConfig = structuredClone(original.config);
    const agents = requireConfigObject(rosterConfig.agents ?? {}, "agents config");
    rosterConfig.agents = {
      ...agents,
      ownership: "explicit",
      entries: {
        main: {},
        Worker: { workspace: "/srv/worker" },
      },
    };
    delete (rosterConfig.agents as Record<string, unknown>).list;

    try {
      await writeJsonFile(original.path, rosterConfig);
      invalidateConfigGetResponseCache();
      const current = await getCurrentConfigObject();
      const submittedConfig = structuredClone(current.config);
      const submittedAgents = requireConfigObject(
        submittedConfig.agents,
        "submitted agents config",
      );
      const submittedEntries = requireConfigObject(
        submittedAgents.entries,
        "submitted agent entries",
      );
      const worker = submittedEntries.Worker ?? submittedEntries.worker;
      delete submittedEntries.Worker;
      submittedEntries.worker = worker;

      const res = await sendConfigSet(configRawPayload(submittedConfig, current.hash));

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      const persisted = JSON.parse(await fs.readFile(original.path, "utf-8")) as {
        agents?: { entries?: Record<string, unknown> };
      };
      expect(Object.keys(persisted.agents?.entries ?? {}).toSorted()).toEqual(["main", "worker"]);
    } finally {
      await restoreConfigFileForTest(original);
      invalidateConfigGetResponseCache();
    }
  });

  it.each(["config.patch", "config.set", "config.apply"])(
    "invalidates a warm config.get response when %s commits a canonical root receipt",
    async (method) => {
      const current = await getCurrentConfigObject();
      const nextConfig = structuredClone(current.config);
      delete nextConfig.meta;
      const ui = (nextConfig.ui ??= {}) as Record<string, unknown>;
      const prefs = (ui.prefs ??= {}) as Record<string, unknown>;
      const locale = prefs.locale === "de" ? "en" : "de";
      prefs.locale = locale;

      const res = await rpcReq<{
        ok?: boolean;
        config?: Record<string, unknown>;
        hash?: string;
      }>(requireClient(), method, {
        ...configRawPayload(nextConfig, current.hash),
      });
      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);

      const after = await rpcReq<{
        config?: Record<string, unknown>;
        sourceConfig?: Record<string, unknown>;
        hash?: string;
      }>(requireClient(), "config.get", {});
      expect(after.ok).toBe(true);
      expect({ config: res.payload?.config, hash: res.payload?.hash }).toEqual({
        config: after.payload?.sourceConfig,
        hash: after.payload?.hash,
      });
      expect(after.payload?.hash).not.toBe(current.hash);
      expect(
        ((after.payload?.config?.ui as Record<string, unknown>)?.prefs as Record<string, unknown>)
          ?.locale,
      ).toBe(locale);
      requireConfigObject(res.payload?.config, "response config");
    },
  );
});

describe("gateway config methods", () => {
  installConfigWriteGatewayHooks();

  it("accepts runtime-shaped config.set when bundled provider baseUrl was only defaulted", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      });
      invalidateConfigGetResponseCache();

      const current = await getCurrentConfigObject();
      const nextConfig = structuredClone(current.runtimeConfig);
      const providers = ((nextConfig.models as Record<string, unknown>).providers ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      providers.openai ??= {};
      providers.openai.baseUrl = "";
      providers.openai.models = [];

      const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
      gateway.port = 19002;

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireClient(), "config.set", {
        ...configRawPayload(nextConfig, current.hash),
      });

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      const persisted = await fs.readFile(configPath, "utf-8");
      expect(persisted).toContain('"port": 19002');
      expect(persisted).not.toContain('"baseUrl"');
    } finally {
      await fs.rm(configPath, { force: true });
      invalidateConfigGetResponseCache();
    }
  });

  it("accepts config.patch when bundled provider baseUrl was only defaulted", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      });
      invalidateConfigGetResponseCache();

      const current = await getCurrentConfigObject();

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ gateway: { port: 19003 } }),
        baseHash: current.hash,
      });

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      const persisted = await fs.readFile(configPath, "utf-8");
      expect(persisted).toContain('"port": 19003');
      expect(persisted).not.toContain('"baseUrl"');
      expect(persisted).not.toContain('"models": []');
    } finally {
      await fs.rm(configPath, { force: true });
      invalidateConfigGetResponseCache();
    }
  });

  it("preserves authored empty bundled provider models during config.patch", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
              models: [],
            },
          },
        },
      });
      invalidateConfigGetResponseCache();

      const current = await getCurrentConfigObject();

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ gateway: { port: 19004 } }),
        baseHash: current.hash,
      });

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        models?: { providers?: { openai?: { baseUrl?: unknown; models?: unknown } } };
      };
      expect(persisted.models?.providers?.openai?.baseUrl).toBeUndefined();
      expect(persisted.models?.providers?.openai?.models).toEqual([]);
    } finally {
      await fs.rm(configPath, { force: true });
      invalidateConfigGetResponseCache();
    }
  });

  it.each([false, true])(
    "keeps model ID patches source-owned (authored compat: %s)",
    async (authoredCompat) => {
      await withEnvAsync(
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve(import.meta.dirname, "../../dist/extensions"),
        },
        async () => {
          const configIo = await import("../config/io.js");
          const original = await getCurrentConfigObject();
          const textModel = {
            id: "gpt-5.6-luna",
            name: "Text model",
            ...(authoredCompat ? { compat: { supportsStore: false } } : {}),
          };
          try {
            await writeJsonFile(original.path, {
              gateway: { reload: { mode: "off" } },
              models: {
                providers: {
                  openai: { models: [textModel, { id: "gpt-image-1", name: "Image model" }] },
                },
              },
            });
            invalidateConfigGetResponseCache();
            const before = await configIo.readConfigFileSnapshot();
            expect(before.issues).toEqual([]);
            const runtimeModel = before.config.models?.providers?.openai?.models[0];
            expect(runtimeModel?.contextTokens).toBeGreaterThan(0);
            expect(runtimeModel?.compat).toBeDefined();

            const imageModel = {
              id: "gpt-image-1",
              name: "Image model",
              baseUrl: "http://127.0.0.1:44080/v1",
            };
            const res = await rpcReq(requireClient(), "config.patch", {
              raw: JSON.stringify({ models: { providers: { openai: { models: [imageModel] } } } }),
              baseHash: await getConfigHash(),
            });
            expect(res.error).toBeUndefined();
            expect(res.ok, res.error?.message).toBe(true);
            const persisted = JSON.parse(await fs.readFile(original.path, "utf-8"));
            expect(persisted.models.providers.openai.models).toEqual([textModel, imageModel]);

            const after = await configIo.readConfigFileSnapshot();
            expect(after.valid).toBe(true);
            expect(after.config.models?.providers?.openai?.models[0]).toEqual(runtimeModel);
          } finally {
            await restoreConfigFileForTest(original);
            invalidateConfigGetResponseCache();
          }
        },
      );
    },
  );

  it("round-trips prototype-like browser profile names through config.patch", async () => {
    const original = await getCurrentConfigObject();
    const profileNames = ["constructor", "prototype"] as const;

    try {
      const create = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({
          browser: {
            profiles: Object.fromEntries(
              profileNames.map((name, index) => [
                name,
                {
                  cdpPort: 18991 + index,
                  constructor: { polluted: true },
                  prototype: { polluted: true },
                },
              ]),
            ),
          },
        }),
        baseHash: original.hash,
      });
      expect(create.ok).toBe(true);

      const afterCreate = await getCurrentConfigObject();
      const browser = requireConfigObject(afterCreate.config.browser, "browser");
      const profiles = requireConfigObject(browser.profiles, "browser.profiles");
      for (const [index, name] of profileNames.entries()) {
        const profile = requireConfigObject(profiles[name], `browser.profiles.${name}`);
        expect(profile.cdpPort).toBe(18991 + index);
        expect(Object.hasOwn(profile, "constructor")).toBe(false);
        expect(Object.hasOwn(profile, "prototype")).toBe(false);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      const remove = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({
          browser: { profiles: { constructor: null, prototype: null } },
        }),
        baseHash: afterCreate.hash,
      });
      expect(remove.ok).toBe(true);

      const afterRemove = await getCurrentConfigObject();
      const afterBrowser = requireConfigObject(afterRemove.config.browser, "browser");
      const afterProfiles = requireConfigObject(afterBrowser.profiles, "browser.profiles");
      for (const name of profileNames) {
        expect(Object.hasOwn(afterProfiles, name)).toBe(false);
      }
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects concurrent config.patch writes that share a stale base hash", async () => {
    const original = await getCurrentConfigObject();
    const names = Array.from({ length: 8 }, (_, index) => `concurrent-mcp-${index}`);

    try {
      const results = await Promise.all(
        names.map((name, index) =>
          rpcReq<{ ok?: boolean; error?: { message?: string } }>(requireClient(), "config.patch", {
            raw: JSON.stringify({
              mcp: {
                servers: {
                  [name]: { command: "node", args: [`server-${index}.mjs`] },
                },
              },
            }),
            baseHash: original.hash,
          }),
        ),
      );

      expect(results.filter((result) => result.ok).length).toBe(1);
      const failures = results.filter((result) => !result.ok);
      expect(failures).toHaveLength(names.length - 1);
      for (const failure of failures) {
        expect(failure.error?.message).toContain("config changed since last load");
      }

      const after = await getCurrentConfigObject();
      const mcp = requireConfigObject(after.config.mcp, "mcp");
      const servers = requireConfigObject(mcp.servers, "mcp.servers");
      expect(names.filter((name) => Object.hasOwn(servers, name))).toHaveLength(1);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("does not reject config.set for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_${Date.now()}`;
    await writeUnresolvedAuthProfileTokenRef(missingEnvVar);

    const current = await getCurrentConfigObject();

    const res = await rpcReq<{ ok?: boolean; error?: { message?: string } }>(
      requireClient(),
      "config.set",
      configRawPayload(current.config, current.hash),
    );

    expect(res.ok, res.error?.message).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

describe("gateway config methods", () => {
  installSharedConfigWriteGatewayHooks();

  it.each(["config.set", "config.apply", "config.patch"] as const)(
    "preserves literal nulls in full replacements and patch deletion through %s",
    async (method) => {
      const original = await getCurrentConfigObject();
      const seed = structuredClone(original.config);
      const agents = requireConfigObject(seed.agents, "agents");
      const defaults = requireConfigObject(agents.defaults ?? {}, "agent defaults");
      agents.defaults = { ...defaults, params: { temperature: 0.2, topP: 0.8 } };

      try {
        await writeJsonFile(original.path, seed);
        invalidateConfigGetResponseCache();
        const current = await getCurrentConfigObject();
        const next = structuredClone(current.config);
        const nextAgents = requireConfigObject(next.agents, "agents");
        const nextDefaults = requireConfigObject(nextAgents.defaults, "agent defaults");
        nextDefaults.params = { temperature: null, nested: { value: null } };
        const patch = { agents: { defaults: { params: { temperature: null, topP: null } } } };

        const res = await rpcReq(requireClient(), method, {
          raw: JSON.stringify(method === "config.patch" ? patch : next),
          baseHash: current.hash,
        });

        expect(res.ok, res.error?.message).toBe(true);
        const persisted = JSON.parse(await fs.readFile(original.path, "utf-8"));
        expect(persisted.agents.defaults).toStrictEqual({
          ...defaults,
          params: method === "config.patch" ? {} : { temperature: null, nested: { value: null } },
        });
      } finally {
        await restoreConfigFileForTest(original);
        invalidateConfigGetResponseCache();
      }
    },
  );

  it("acknowledges sandbox config only after the runtime snapshot applies it", async () => {
    const original = await getCurrentConfigObject();
    const image = `openclaw-settlement-${randomUUID()}:test`;

    try {
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: { defaults: { sandbox: { docker: { image } } } } }),
        baseHash: original.hash,
      });

      expect(res.ok, res.error?.message).toBe(true);
      expect(getRuntimeConfig().agents?.defaults?.sandbox?.docker?.image).toBe(image);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("accepts messages.groupChat.historyLimit: 0 through config.patch", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    let previousConfig: string | null = null;
    try {
      try {
        previousConfig = await fs.readFile(configPath, "utf-8");
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          throw error;
        }
      }
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ messages: { groupChat: { historyLimit: 1 } } }, null, 2)}\n`,
        "utf-8",
      );
      invalidateConfigGetResponseCache();

      const current = await rpcReq<{ hash?: string }>(requireClient(), "config.get", {});
      expect(current.ok).toBe(true);
      expect(typeof current.payload?.hash).toBe("string");

      const res = await rpcReq<{
        config?: { messages?: { groupChat?: { historyLimit?: number } } };
      }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ messages: { groupChat: { historyLimit: 0 } } }),
        baseHash: current.payload?.hash,
      });

      expect(res.error).toBeUndefined();
      expect(res.ok, res.error?.message).toBe(true);
      expect(res.payload?.config?.messages?.groupChat?.historyLimit).toBe(0);
    } finally {
      if (previousConfig === null) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, previousConfig, "utf-8");
      }
      invalidateConfigGetResponseCache();
    }
  });

  it("allows config.patch to append array entries without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const nextBindings = [...bindings, makeRouteBinding(2)];
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ bindings: nextBindings }),
        baseHash: before.hash,
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      expect(after.config.bindings).toEqual(nextBindings);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows config.patch to shrink an existing array with replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1, 2].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const replacement = [bindings[0]];
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ bindings: replacement }),
        baseHash: before.hash,
        replacePaths: ["bindings"],
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      expect(after.config.bindings).toEqual(replacement);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });
});

describe("gateway config methods", () => {
  // Channel policy replaces plugin runtime, which global per-case cleanup retires.
  installConfigWriteGatewayHooks();

  it("accepts exact numeric record keys in replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const channels =
      original.config.channels &&
      typeof original.config.channels === "object" &&
      !Array.isArray(original.config.channels)
        ? (original.config.channels as Record<string, unknown>)
        : {};
    const discord = {
      ...(channels.discord as Record<string, unknown> | undefined),
      allowFrom: ["*"],
      guilds: {
        "123": {
          channels: {
            general: {
              users: ["111", "222"],
            },
          },
        },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, channels: { ...channels, discord } }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({
          channels: {
            discord: {
              guilds: { "123": { channels: { general: { users: ["111"] } } } },
            },
          },
        }),
        baseHash: before.hash,
        replacePaths: ["channels.discord.guilds.123.channels.general.users"],
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      const afterChannels = requireConfigObject(after.config.channels, "channels");
      expect(
        (
          afterChannels.discord as {
            guilds?: { "123"?: { channels?: { general?: { users?: unknown[] } } } };
          }
        ).guilds?.["123"]?.channels?.general?.users,
      ).toEqual(["111"]);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows nested destructive array patches inside id-keyed arrays with replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      ownership: "explicit",
      entries: {
        main: { skills: ["alpha", "beta"] },
        worker: { skills: ["gamma"] },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> }).entries;
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
        baseHash: before.hash,
        replacePaths: ["agents.entries.main.skills"],
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual({
        ...beforeEntries,
        main: {
          ...(beforeEntries?.main as Record<string, unknown> | undefined),
          skills: ["alpha"],
        },
      });
    } finally {
      await restoreConfigFileForTest(original);
    }
  });
});

describe("gateway config.apply", () => {
  installConfigWriteGatewayHooks();

  it("does not reject config.apply for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_APPLY_${Date.now()}`;
    await writeUnresolvedAuthProfileTokenRef(missingEnvVar);

    const current = await getCurrentConfigObject();

    const res = await sendConfigApply(configRawPayload(current.config, current.hash));
    expect(res.ok, res.error?.message).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

describe("gateway config recovery errors", () => {
  installSharedConfigWriteGatewayHooks({
    configRelativePath: path.join(
      "long-config-location-".repeat(4),
      "long-config-location-".repeat(4),
      "long-config-location-".repeat(4),
      "openclaw.json",
    ),
    fixturePaths: ["logging.json"],
  });

  it.each(["config.set", "config.patch", "config.apply"])(
    "%s preserves the failed-recovery outcome and backup location with built-in and custom redaction",
    async (method) => {
      const original = await getCurrentConfigObject();
      expect(original.path.length).toBeGreaterThan(240);
      const includePath = path.join(path.dirname(original.path), "logging.json");
      await writeJsonFile(includePath, { level: "info" });
      await writeJsonFile(original.path, {
        ...original.config,
        logging: { $include: "logging.json" },
        gateway: { reload: { mode: "off" } },
      });
      invalidateConfigGetResponseCache();
      const draft = await getCurrentConfigObject();
      const rootBefore = await fs.readFile(original.path, "utf8");
      const credential = `synthetic-credential-${"x".repeat(32)}`;
      const customDetail = "project-private-marker";
      applyLoggingConfig({
        level: "silent",
        consoleLevel: "silent",
        redactPatterns: [`/${customDetail}/g`],
      });
      const rename = fsNode.renameSync;
      vi.spyOn(fsNode, "renameSync").mockImplementation((source, destination) => {
        if (destination !== original.path) {
          return rename(source, destination);
        }
        throw Object.assign(new Error("rename denied"), { code: "EPERM" });
      });
      let rootRemoved = false;
      const remove = fsNode.rmSync;
      vi.spyOn(fsNode, "rmSync").mockImplementation((filePath, options) => {
        remove(filePath, options);
        if (filePath === original.path) {
          rootRemoved = true;
          fsNode.writeFileSync(includePath, JSON.stringify({ level: "debug" }));
        }
      });
      let recoveryStageDenied = false;
      const open = fsNode.openSync;
      vi.spyOn(fsNode, "openSync").mockImplementation((filePath, flags, mode) => {
        if (
          rootRemoved &&
          typeof filePath === "string" &&
          path.dirname(filePath) === path.dirname(original.path) &&
          path.basename(filePath).startsWith(".fs-safe-replace.") &&
          filePath.endsWith(".tmp")
        ) {
          recoveryStageDenied = true;
          throw Object.assign(
            new Error(
              `recovery staging has no space; Authorization: Bearer ${credential}; ${customDetail}`,
            ),
            { code: "ENOSPC" },
          );
        }
        return open(filePath, flags, mode);
      });

      const patch = { ui: { prefs: { locale: "fr" } } };
      const result = await rpcReq(requireClient(), method, {
        raw: JSON.stringify(method === "config.patch" ? patch : { ...draft.config, ...patch }),
        baseHash: draft.hash,
      });

      expect(recoveryStageDenied).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({
        code: "UNAVAILABLE",
        details: {
          publication: "partial",
          rollbackStatus: "unknown",
          configPath: original.path,
          recoveryBackupPath: `${original.path}.bak`,
        },
      });
      expect(result.error?.message).toContain("recovery staging has no space");
      expect(result.error?.message).not.toContain(credential);
      expect(result.error?.message).not.toContain(customDetail);
      expect(result.error?.message).toContain("Rollback could not be confirmed.");
      expect(result.error?.message).toContain(`Inspect recovery backups at ${original.path}.bak.`);
      await expect(fs.stat(original.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(`${original.path}.bak`, "utf8")).toBe(rootBefore);
      expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({ level: "debug" });
    },
  );
});

describe("gateway noncommitting config RPCs", () => {
  installReadOnlyConfigGatewayHooks();

  describe("gateway config methods", () => {
    it("rejects the internal raw digest as a public config base hash", async () => {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const current = await getCurrentConfigObject();
      const internal = await readConfigFileSnapshot();
      expect(typeof internal.hash).toBe("string");

      const response = await sendConfigSet(configRawPayload(current.config, internal.hash));

      expect(response.ok).toBe(false);
      expect(response.error?.message).toContain("config changed since last load");
    });

    it("rejects config.set when SecretRef resolution fails", async () => {
      const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_${Date.now()}`;
      deleteTestEnvValue(missingEnvVar);
      const current = await getCurrentConfigObject();
      const nextConfig = configWithGatewayTokenSecretRef(current.config, missingEnvVar);

      const res = await sendConfigSet(
        configRawPayload(nextConfig, current.hash),
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
      const afterHash = await getConfigHash();
      expect(afterHash).toBe(current.hash);
    });

    it("rejects config.patch when merged SecretRefs cannot resolve", async () => {
      const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_PATCH_${Date.now()}`;
      deleteTestEnvValue(missingEnvVar);
      const beforeHash = await getConfigHash();
      const res = await rpcReq<{ ok?: boolean; error?: { message?: string } }>(
        requireClient(),
        "config.patch",
        {
          raw: JSON.stringify({
            gateway: {
              auth: {
                mode: "token",
                token: {
                  source: "env",
                  provider: "default",
                  id: missingEnvVar,
                },
              },
            },
          }),
          baseHash: beforeHash,
        },
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
      const afterHash = await getConfigHash();
      expect(afterHash).toBe(beforeHash);
    });

    it("returns noop for config.patch when authored config is unchanged", async () => {
      const current = await getCurrentConfigObject();

      // Replaying runtime defaults would explicitly author them into the source config.
      const res = await rpcReq<{
        ok?: boolean;
        noop?: boolean;
        config?: Record<string, unknown>;
      }>(requireClient(), "config.patch", {
        raw: JSON.stringify(current.config),
        baseHash: current.hash,
      });

      expect(res.ok, res.error?.message).toBe(true);
      expect(res.payload?.noop).toBe(true);
      // Config hash should not change (no file write)
      const after = await rpcReq<{ hash?: string }>(requireClient(), "config.get", {});
      expect(after.payload?.hash).toBe(current.hash);
    });

    it("includes the active runtime config revision", async () => {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const { getRuntimeConfigAppliedHash, hashRuntimeConfigValue } =
        await import("../config/runtime-snapshot.js");
      const current = await rpcReq<{
        hash?: string;
        configRevisionHash?: string;
        appliedConfigHash?: string | null;
      }>(requireClient(), "config.get", {});

      expect(current.ok).toBe(true);
      expect(current.payload).toHaveProperty("configRevisionHash");
      expect(current.payload).toHaveProperty("appliedConfigHash");
      const internal = await readConfigFileSnapshot();
      expect(current.payload?.hash).not.toBe(internal.hash);
      expect(current.payload?.configRevisionHash).not.toBe(
        hashRuntimeConfigValue(internal.sourceConfig),
      );
      const internalAppliedHash = getRuntimeConfigAppliedHash();
      if (internalAppliedHash === null) {
        expect(current.payload?.appliedConfigHash).toBeNull();
      } else {
        expect(current.payload?.appliedConfigHash).not.toBe(internalAppliedHash);
      }
    });

    it("returns config.set validation details in the top-level error message", async () => {
      const res = await rpcReq<{
        ok?: boolean;
        error?: {
          message?: string;
        };
      }>(requireClient(), "config.set", {
        raw: JSON.stringify({ gateway: { bind: 123 } }),
        baseHash: await getConfigHash(),
      });
      const error = res.error as
        | {
            message?: string;
            details?: {
              issues?: Array<{ path?: string; message?: string }>;
            };
          }
        | undefined;

      expect(res.ok).toBe(false);
      expect(error?.message ?? "").toContain("invalid config:");
      expect(error?.message ?? "").toContain("gateway.bind");
      expect(error?.message ?? "").toContain("allowed:");
      expect(error?.details?.issues?.[0]?.path).toBe("gateway.bind");
    });

    it("rejects config.patch when raw is null", async () => {
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: "null",
        baseHash: await getConfigHash(),
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("raw must be an object");
    });

    it.each([
      { source: "a stale snapshot", legacyDuplicate: false },
      { source: "an invalid duplicate legacy roster", legacyDuplicate: true },
    ])(
      "rejects config.set when $source drops an agent entry without changing disk",
      async ({ legacyDuplicate }) => {
        const original = await getCurrentConfigObject();
        const includedGateway = { mode: "local", reload: { mode: "off" } };
        const includeRaw = `${JSON.stringify(includedGateway, null, 3)}\n`;
        let includePath: string | undefined;
        let rosterConfig = structuredClone(original.config);
        const agents = requireConfigObject(rosterConfig.agents ?? {}, "agents config");
        rosterConfig.agents = {
          ...agents,
          entries: {
            main: { default: true },
            worker: { workspace: "/srv/worker" },
          },
        };
        delete (rosterConfig.agents as Record<string, unknown>).list;

        await withConfigFileFixture(original.path, async () => {
          try {
            if (legacyDuplicate) {
              const configIo = await import("../config/io.js");
              const fixtureIncludePath = path.join(
                path.dirname(original.path),
                "retention-gateway.json",
              );
              await fs.writeFile(fixtureIncludePath, includeRaw, { encoding: "utf-8", flag: "wx" });
              includePath = fixtureIncludePath;
              rosterConfig = {
                agents: {
                  list: [
                    { id: "Research", name: "First research agent" },
                    { id: "Research", name: "Second research agent" },
                  ],
                },
                gateway: { $include: path.basename(includePath) },
                plugins: { enabled: false },
              };
              await writeJsonFile(original.path, rosterConfig);
              const snapshot = await configIo.readConfigFileSnapshot();
              expect(snapshot.valid).toBe(false);
              expect(snapshot.parsed).toEqual(rosterConfig);
              expect(snapshot.sourceConfig.gateway).toEqual(includedGateway);
            } else {
              await writeJsonFile(original.path, rosterConfig);
            }
            invalidateConfigGetResponseCache();
            const current = await getCurrentConfigObject();
            const staleConfig = legacyDuplicate
              ? {
                  agents: { entries: { research: { name: "First research agent" } } },
                  gateway: includedGateway,
                  plugins: { enabled: false },
                }
              : structuredClone(current.config);
            if (legacyDuplicate) {
              expect(current.valid).toBe(false);
              expect(current.raw).toBeNull();
              expect(current.hash).not.toBe(original.hash);
            } else {
              const staleAgents = requireConfigObject(staleConfig.agents, "stale agents config");
              const staleEntries = requireConfigObject(staleAgents.entries, "stale agent entries");
              delete staleEntries.worker;
            }
            const before = await fs.readFile(original.path, "utf-8");

            const res = await sendConfigSet(configRawPayload(staleConfig, current.hash));

            await expect(
              fs.readFile(original.path, "utf-8"),
              `config.set response ok=${String(res.ok)}`,
            ).resolves.toBe(before);
            if (includePath) {
              await expect(fs.readFile(includePath, "utf-8")).resolves.toBe(includeRaw);
            }

            expect(res.ok).toBe(false);
            if (legacyDuplicate) {
              expect(res.error?.message ?? "").toContain(
                "Config write would drop agent roster entries without an explicit deletion: research-2.",
              );
            } else {
              expect(res.error?.code).toBe("INVALID_REQUEST");
              expect(res.error?.message ?? "").toContain("worker");
              expect(res.error?.message ?? "").toContain("agents.delete RPC");
              expect(res.error?.message ?? "").toContain("openclaw agents delete");
            }
          } finally {
            if (includePath) {
              await fs.rm(includePath, { force: true });
            }
          }
        });
      },
    );

    it("redacts browser cdpUrl credentials from config.get responses", async () => {
      const original = await getCurrentConfigObject();
      const configPath = original.path;
      await withConfigFileFixture(original.path, async () => {
        await writeJsonFile(configPath, {
          browser: {
            cdpUrl: "https://user:pass@chrome.browserless.io?token=supersecret123",
            profiles: {
              remote: {
                cdpUrl: "https://alice:secret@chrome.remote.example.com?token=profile-secret",
              },
              local: {
                cdpUrl: "ws://127.0.0.1:9222",
              },
            },
          },
        });
        invalidateConfigGetResponseCache();

        const after = await rpcReq<{
          raw?: string | null;
          config?: {
            browser?: {
              cdpUrl?: string;
              profiles?: Record<string, { cdpUrl?: string }>;
            };
          };
        }>(requireClient(), "config.get", {});
        expect(after.ok).toBe(true);
        expect(after.payload?.config?.browser?.cdpUrl).toBe("__OPENCLAW_REDACTED__");
        expect(after.payload?.config?.browser?.profiles?.remote?.cdpUrl).toBe(
          "__OPENCLAW_REDACTED__",
        );
        expect(after.payload?.config?.browser?.profiles?.local?.cdpUrl).toBe("ws://127.0.0.1:9222");
        if (typeof after.payload?.raw === "string") {
          expect(after.payload.raw).toContain("__OPENCLAW_REDACTED__");
          expect(after.payload.raw).not.toContain("supersecret123");
          expect(after.payload.raw).not.toContain("user:pass@");
          expect(after.payload.raw).not.toContain("profile-secret");
          expect(after.payload.raw).not.toContain("alice:secret@");
        }
      });
    });

    it("rejects config.patch that shrinks an existing array without replacePaths", async () => {
      const original = await getCurrentConfigObject();
      const bindings = [0, 1, 2].map(makeRouteBinding);
      const seededConfig = { ...original.config, bindings };

      await withConfigFileFixture(original.path, async () => {
        await writeJsonFile(original.path, seededConfig);
        invalidateConfigGetResponseCache();
        const before = await getCurrentConfigObject();
        const beforeRaw = await fs.readFile(original.path, "utf-8");
        const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
          raw: JSON.stringify({ bindings: [bindings[0]] }),
          baseHash: before.hash,
        });

        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain(
          "config.patch would remove entries from array path(s): bindings",
        );
        const after = await getCurrentConfigObject();
        expect(after.hash).toBe(before.hash);
        await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
        expect(after.config.bindings).toEqual(bindings);
      });
    });

    it("rejects config.patch that removes existing array entries without shrinking length", async () => {
      const original = await getCurrentConfigObject();
      const bindings = [0, 1].map(makeRouteBinding);
      const seededConfig = { ...original.config, bindings };

      await withConfigFileFixture(original.path, async () => {
        await writeJsonFile(original.path, seededConfig);
        invalidateConfigGetResponseCache();
        const before = await getCurrentConfigObject();
        const beforeRaw = await fs.readFile(original.path, "utf-8");
        const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
          raw: JSON.stringify({ bindings: [bindings[1], makeRouteBinding(2)] }),
          baseHash: before.hash,
        });

        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain(
          "config.patch would remove entries from array path(s): bindings",
        );
        const after = await getCurrentConfigObject();
        expect(after.hash).toBe(before.hash);
        await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
        expect(after.config.bindings).toEqual(bindings);
      });
    });

    it("rejects nested destructive array patches inside id-keyed arrays without replacePaths", async () => {
      const original = await getCurrentConfigObject();
      const agents = {
        ...(original.config.agents as Record<string, unknown> | undefined),
        ownership: "explicit",
        entries: {
          main: { skills: ["alpha", "beta"] },
          worker: { skills: ["gamma"] },
        },
      };

      await withConfigFileFixture(original.path, async () => {
        await writeJsonFile(original.path, { ...original.config, agents });
        invalidateConfigGetResponseCache();
        const before = await getCurrentConfigObject();
        const beforeRaw = await fs.readFile(original.path, "utf-8");
        const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> })
          .entries;
        const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
          raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
          baseHash: before.hash,
        });

        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain(
          "config.patch would remove entries from array path(s): agents.entries.main.skills",
        );
        const after = await getCurrentConfigObject();
        expect(after.hash).toBe(before.hash);
        await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
        expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual(
          beforeEntries,
        );
      });
    });

    it("rejects nested destructive array patches when replacePaths names only a parent object", async () => {
      const original = await getCurrentConfigObject();
      const agents = {
        ...(original.config.agents as Record<string, unknown> | undefined),
        ownership: "explicit",
        entries: {
          main: { skills: ["alpha", "beta"] },
          worker: { skills: ["gamma"] },
        },
      };

      await withConfigFileFixture(original.path, async () => {
        await writeJsonFile(original.path, { ...original.config, agents });
        invalidateConfigGetResponseCache();
        const before = await getCurrentConfigObject();
        const beforeRaw = await fs.readFile(original.path, "utf-8");
        const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> })
          .entries;
        const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
          raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
          baseHash: before.hash,
          replacePaths: ["agents"],
        });

        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain(
          "config.patch would remove entries from array path(s): agents.entries.main.skills",
        );
        const after = await getCurrentConfigObject();
        expect(after.hash).toBe(before.hash);
        await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
        expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual(
          beforeEntries,
        );
      });
    });

    it("rejects deleting a parent object that contains arrays without replacePaths", async () => {
      const original = await getCurrentConfigObject();
      const agents = {
        ...(original.config.agents as Record<string, unknown> | undefined),
        ownership: "explicit",
        entries: { main: { skills: ["alpha"] }, worker: {} },
      };

      await withConfigFileFixture(original.path, async () => {
        await writeJsonFile(original.path, { ...original.config, agents });
        invalidateConfigGetResponseCache();
        const before = await getCurrentConfigObject();
        const beforeRaw = await fs.readFile(original.path, "utf-8");
        const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
          raw: JSON.stringify({ agents: null }),
          baseHash: before.hash,
        });

        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain(
          "config.patch would remove entries from array path(s): agents.entries.main.skills",
        );
        const after = await getCurrentConfigObject();
        expect(after.hash).toBe(before.hash);
        await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
      });
    });

    it("rejects deleting a nested parent object inside id-keyed arrays without replacePaths", async () => {
      const original = await getCurrentConfigObject();
      const agents = {
        ...(original.config.agents as Record<string, unknown> | undefined),
        ownership: "explicit",
        entries: {
          main: {
            subagents: { allowAgents: ["worker"] },
          },
          worker: {},
        },
      };

      await withConfigFileFixture(original.path, async () => {
        await writeJsonFile(original.path, { ...original.config, agents });
        invalidateConfigGetResponseCache();
        const before = await getCurrentConfigObject();
        const beforeRaw = await fs.readFile(original.path, "utf-8");
        const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
          raw: JSON.stringify({ agents: { entries: { main: { subagents: null } } } }),
          baseHash: before.hash,
        });

        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain(
          "config.patch would remove entries from array path(s): agents.entries.main.subagents.allowAgents",
        );
        const after = await getCurrentConfigObject();
        expect(after.hash).toBe(before.hash);
        await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
      });
    });
  });

  describe("gateway config.apply", () => {
    it("rejects config.apply when SecretRef resolution fails", async () => {
      const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_APPLY_${Date.now()}`;
      deleteTestEnvValue(missingEnvVar);
      const current = await getCurrentConfigObject();
      const nextConfig = configWithGatewayTokenSecretRef(current.config, missingEnvVar);

      const res = await sendConfigApply(
        configRawPayload(nextConfig, current.hash),
        CONFIG_SECRETREF_RPC_TIMEOUT_MS,
      );
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");

      const after = await rpcReq<{
        hash?: string;
        raw?: string | null;
      }>(requireClient(), "config.get", {});
      expect(after.ok).toBe(true);
      expect(after.payload?.hash).toBe(current.hash);
      expect(after.payload?.raw).toBe(current.raw);
    });

    it("rejects invalid raw config", async () => {
      const currentHash = await getConfigHash();
      const res = await sendConfigApply({ raw: "{", baseHash: currentHash });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toMatch(/invalid|SyntaxError/i);
    });

    it("requires raw to be a string", async () => {
      const currentHash = await getConfigHash();
      const res = await sendConfigApply({
        raw: { gateway: { mode: "local" } },
        baseHash: currentHash,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("raw");
    });
  });

  describe("gateway config schema lookup", () => {
    it("returns a path-scoped config schema lookup", async () => {
      const res = await rpcReq<{
        path: string;
        hintPath?: string;
        children?: Array<{ key: string; path: string; required: boolean; hintPath?: string }>;
        schema?: { properties?: unknown };
      }>(requireClient(), "config.schema.lookup", {
        path: "gateway.auth",
      });

      expect(res.ok, res.error?.message).toBe(true);
      expect(res.payload?.path).toBe("gateway.auth");
      expect(res.payload?.hintPath).toBe("gateway.auth");
      const tokenChild = res.payload?.children?.find((child) => child.key === "token");
      expect(tokenChild?.key).toBe("token");
      expect(tokenChild?.path).toBe("gateway.auth.token");
      expect(tokenChild?.hintPath).toBe("gateway.auth.token");
      expect(res.payload?.schema?.properties).toBeUndefined();
    });

    it("returns consistent help and reload metadata for plugin enablement", async () => {
      const res = await rpcReq<{
        path: string;
        schema?: { description?: string };
        reloadKind?: string;
        hintPath?: string;
        hint?: { help?: string };
      }>(requireClient(), "config.schema.lookup", {
        path: "plugins.entries.sample-plugin.enabled",
      });

      expect(res.ok, res.error?.message).toBe(true);
      expect(res.payload).toMatchObject({
        path: "plugins.entries.sample-plugin.enabled",
        reloadKind: "hot",
        hintPath: "plugins.entries.*.enabled",
      });
      const description = res.payload?.schema?.description;
      expect(description).toMatch(/default hybrid reload mode/i);
      expect(description).toMatch(/hot-reload the plugin runtime/i);
      expect(description).not.toMatch(/restart required/i);
      expect(res.payload?.hint?.help).toBe(description);
    });

    it("rejects config.schema.lookup when the path is missing", async () => {
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.schema.lookup", {
        path: "gateway.notReal.path",
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("config schema path not found");
    });

    it.each([
      { name: "rejects config.schema.lookup when the path is only whitespace", pathLocal: "   " },
      {
        name: "rejects config.schema.lookup when the path exceeds the protocol limit",
        pathLocal: `gateway.${"a".repeat(1020)}`,
      },
      {
        name: "rejects config.schema.lookup when the path contains invalid characters",
        pathLocal: "gateway.auth\nspoof",
      },
      {
        name: "rejects config.schema.lookup when the path is not a string",
        pathLocal: 42,
      },
    ])("$name", async ({ pathLocal }) => {
      const res = await rpcReq(requireClient(), "config.schema.lookup", { path: pathLocal });
      expect(res.ok).toBe(false);
      expect(res.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("invalid config.schema.lookup params: at /path:"),
      });
    });

    it("rejects prototype-chain config.schema.lookup paths without reflecting them", async () => {
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.schema.lookup", {
        path: "constructor",
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("config schema path not found");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
