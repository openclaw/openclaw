import { randomUUID } from "node:crypto";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { DuplicateAgentDirError } from "./agent-dirs.js";
import {
  applyConfigEnvVars,
  captureConfigReadEnvMutation,
  cloneEnvWithPlatformSemantics,
  createConfigRuntimeEnvBase,
  snapshotEnv,
  withConfigReadEnvChanges,
} from "./config-env-vars.js";
import { createConfigIO, restoreEnvChangesIfUnchanged } from "./io.js";
import type { ConfigIoFactoryOptions } from "./io.types.js";
import { getConfigResolutionFacts } from "./resolution-facts.js";
import { withTempHome, writeOpenClawConfig, writeStateDirDotEnv } from "./test-helpers.js";
import { withConfigWriteLock } from "./write-lock.js";

function configIO(home: string, env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, homedir: () => home, logger: { warn: () => {}, error: () => {} } });
}

function snapshotIO(options: ConfigIoFactoryOptions) {
  return createConfigIO({ observe: false, pluginValidation: "skip", ...options });
}

const configEnv = (value: string) => ({ env: { vars: { KEY: value } } });

function changeOwned(env: NodeJS.ProcessEnv, key: string, change: string) {
  if (change === "replaced") {
    env[key] = "replacement-owner";
  } else if (change === "deleted") {
    delete env[key];
  }
}

function expectedOwned(change: string, unchanged: string) {
  return change === "unchanged"
    ? unchanged
    : change === "replaced"
      ? "replacement-owner"
      : undefined;
}

describe("restoreEnvChangesIfUnchanged", () => {
  it.each([
    ["equal-byte", "same", "same", "same", "same"],
    ["later-owner", undefined, "value", "value", undefined],
    ["previous-config", undefined, "new", "old", undefined],
  ] as const)(
    "restores a rejected replacement without taking %s ownership",
    (kind, initial, candidate, expected, base) => {
      const env: NodeJS.ProcessEnv = initial === undefined ? {} : { KEY: initial };
      const cfg = configEnv(kind === "previous-config" ? "old" : "same");
      if (kind === "previous-config") {
        applyConfigEnvVars(cfg, env);
      }
      const before = snapshotEnv(env);
      applyConfigEnvVars(
        configEnv(candidate),
        env,
        kind === "later-owner" ? {} : { lowerPrecedenceEnv: { KEY: env.KEY ?? "" } },
      );
      const after = snapshotEnv(env);
      if (kind === "equal-byte") {
        expect(createConfigRuntimeEnvBase(cfg, env).KEY).toBeUndefined();
      }
      if (kind === "later-owner") {
        applyConfigEnvVars({}, env);
      }
      restoreEnvChangesIfUnchanged({ env, before, after });
      expect(env.KEY).toBe(expected);
      if (kind !== "later-owner") {
        expect(createConfigRuntimeEnvBase(cfg, env).KEY).toBe(base);
      }
    },
  );

  it("preserves an externally modified value", () => {
    const env = { KEY: "external-change" };
    restoreEnvChangesIfUnchanged({ env, before: {}, after: { KEY: "config-set" } });
    expect(env.KEY).toBe("external-change");
  });
});

describe("loadConfig env restoration", () => {
  it("returns resolution facts with a valid synchronous load", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      });
      const config = configIO(home, { HOME: home }).loadConfig();

      expect([...(getConfigResolutionFacts(config) ?? [])]).toEqual(["gateway.auth.token"]);
    });
  });

  it("restores env changes after non-INVALID_CONFIG error (DuplicateAgentDirError)", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { DUP_DIR_TEST_VAR: "injected-value" } },
        agents: {
          ownership: "explicit",
          entries: {
            "agent-a": { agentDir: "/tmp/dup-agent-dir" },
            "agent-b": { agentDir: "/tmp/dup-agent-dir" },
          },
        },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = configIO(home, env);

      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
      expect(() => io.loadConfig()).toThrow(DuplicateAgentDirError);
      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
    });
  });
});

async function rejectedReader(change: string, native: boolean) {
  await withTempHome(async (home) => {
    const prefix = native
      ? `OPENCLAW_TEST_NATIVE_${randomUUID().replaceAll("-", "_").toUpperCase()}`
      : "OPENCLAW_TEST_READER";
    const ownedKey = `${prefix}_OWNED`,
      addedKey = `${prefix}_ADDED`,
      deletedKey = `${prefix}_DELETED`;
    const originalKey = native ? ownedKey.toLowerCase() : ownedKey;
    const value = native ? "same" : "candidate";
    const lower = native ? "same" : "lower-precedence";
    const cfg = { env: { vars: { [ownedKey]: value } }, gateway: { port: "invalid" } };
    const configPath = await writeOpenClawConfig(home, cfg);
    const checkEnv = async (env: NodeJS.ProcessEnv) => {
      if (native) {
        // Native aliases enumerate one spelling; equal bytes must still restore ownership.
        env[originalKey] = "same";
        expect(env[ownedKey]).toBe("same");
      }
      let produced:
        | { key: string | undefined; value: string | undefined; base: string | undefined }
        | undefined;
      const io = snapshotIO({
        configPath,
        env,
        lowerPrecedenceEnv: { [ownedKey]: lower },
        measure: async (name, run) => {
          const result = await run();
          if (name === "config.snapshot.read.legacy-issues") {
            produced = {
              key: Object.keys(env).find((key) => key.toUpperCase() === ownedKey),
              value: env[originalKey],
              base: createConfigRuntimeEnvBase({ env: cfg.env }, env)[ownedKey],
            };
            env[native ? addedKey.toLowerCase() : addedKey] = "new-owner";
            delete env[native ? deletedKey.toLowerCase() : deletedKey];
            changeOwned(env, originalKey, change);
          }
          return result;
        },
      });
      const { snapshot } = await io.readConfigFileSnapshotForWrite();
      expect({ valid: snapshot.valid, produced }).toEqual({
        valid: false,
        produced: { key: ownedKey, value, base: undefined },
      });
      const expected = expectedOwned(change, lower);
      const base = createConfigRuntimeEnvBase({ env: cfg.env }, env);
      expect([env[ownedKey], env[originalKey], base[ownedKey]]).toEqual([
        expected,
        expected,
        expected,
      ]);
      expect([env[addedKey], env[deletedKey]]).toEqual(["new-owner", undefined]);
      if (native) {
        expect(Object.keys(env).filter((key) => key.toUpperCase() === ownedKey)).toEqual(
          change === "deleted" ? [] : [change === "unchanged" ? originalKey : ownedKey],
        );
      }
    };
    if (native) {
      await withEnvAsync(
        { [ownedKey]: undefined, [addedKey]: undefined, [deletedKey]: "previous-owner" },
        () => checkEnv(process.env),
      );
    } else {
      await checkEnv({ HOME: home, [ownedKey]: lower, [deletedKey]: "previous-owner" });
    }
  });
}

it.each(["unchanged", "replaced", "deleted"])(
  "preserves foreign env changes during invalid for-write validation (owned=%s)",
  (change) => rejectedReader(change, false),
);

describe("config read producer receipts", () => {
  it.skipIf(process.platform !== "win32").each(["unchanged", "replaced", "deleted"])(
    "restores native Windows env ownership without taking foreign changes (owned=%s)",
    async (change) => {
      expect([process.platform, isMainThread]).toEqual(["win32", true]);
      await rejectedReader(change, true);
    },
  );

  it("restores equal-byte lower-precedence ownership after a rejected real snapshot", async () => {
    await withTempHome(async (home) => {
      const cfg = { env: { vars: { KEY: "same" } }, gateway: { port: "invalid" } };
      const configPath = await writeOpenClawConfig(home, cfg);
      const env = { HOME: home, KEY: "same" };
      const io = snapshotIO({
        configPath,
        env,
        lowerPrecedenceEnv: { KEY: "same" },
      });
      expect((await io.readConfigFileSnapshot()).valid).toBe(false);
      expect(env.KEY).toBe("same");
      expect(createConfigRuntimeEnvBase({ env: cfg.env }, env).KEY).toBe("same");
    });
  });

  it("preserves a later ownership change with unchanged bytes", async () => {
    const env: NodeJS.ProcessEnv = {};
    await withConfigReadEnvChanges(env, async (restore) => {
      captureConfigReadEnvMutation(env, () => applyConfigEnvVars(configEnv("value"), env));
      await Promise.resolve();
      applyConfigEnvVars({}, env);
      restore();
      expect(env.KEY).toBe("value");
    });
  });

  it("shares a one-time receipt between snapshot rejection and containing compensation", async () => {
    const env: NodeJS.ProcessEnv = {};
    await withConfigReadEnvChanges(env, async (restore) => {
      let rejectSnapshot = () => {};
      captureConfigReadEnvMutation(
        env,
        () => {
          env.KEY = "candidate";
        },
        (receipt) => {
          rejectSnapshot = receipt;
        },
      );
      rejectSnapshot();
      env.KEY = "candidate";
      restore();
      expect(env.KEY).toBe("candidate");
    });
  });

  it.each(
    (["plain", "alias"] as const).flatMap((kind) =>
      [false, true].map((ownershipOnly) => ({ kind, ownershipOnly })),
    ),
  )(
    "restores Windows $kind receipts (ownership only=$ownershipOnly)",
    async ({ kind, ownershipOnly }) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        const initial = { key: ownershipOnly ? "" : "old" };
        const env: NodeJS.ProcessEnv =
          kind === "alias"
            ? cloneEnvWithPlatformSemantics(initial)
            : { ...initial, ...(ownershipOnly ? {} : { KEY: "separate" }) };
        const config = configEnv("value");
        if (ownershipOnly) {
          applyConfigEnvVars(config, env);
          expect(Object.keys(env)).toEqual(kind === "alias" ? ["key"] : ["key", "KEY"]);
        }
        await withConfigReadEnvChanges(env, async (restore) => {
          captureConfigReadEnvMutation(env, () => {
            if (ownershipOnly) {
              applyConfigEnvVars({}, env);
            } else {
              delete env.key;
              env.KEY = "candidate";
            }
          });
          await Promise.resolve();
          if (!ownershipOnly) {
            env.UNRELATED = "foreign";
          }
          restore();
        });
        if (ownershipOnly) {
          expect(env.KEY).toBe("value");
          expect(Object.entries(createConfigRuntimeEnvBase(config, env))).toEqual(
            kind === "plain" ? [["key", ""]] : [],
          );
          if (kind === "plain") {
            expect(env.key).toBe("");
          }
        } else {
          expect(env).toMatchObject({
            key: "old",
            KEY: kind === "alias" ? "old" : "separate",
            UNRELATED: "foreign",
          });
        }
      } finally {
        platform.mockRestore();
      }
    },
  );

  it("restores partial synchronous producer writes without taking a later foreign write", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        env: { vars: { FIRST: "candidate", BLOCKED: "candidate" } },
      });
      const failure = new Error("producer refused second assignment");
      const env = new Proxy<NodeJS.ProcessEnv>(
        { HOME: home },
        {
          set(target, key, value) {
            if (key === "BLOCKED") {
              throw failure;
            }
            return Reflect.set(target, key, value);
          },
        },
      );
      const io = snapshotIO({
        configPath,
        env,
        logger: { warn: () => {}, error: () => {} },
        measure: async (name, run) => {
          try {
            return await run();
          } catch (error) {
            if (name === "config.snapshot.read.env") {
              env.FOREIGN = "preserved";
            }
            throw error;
          }
        },
      });
      expect((await io.readConfigFileSnapshot()).valid).toBe(false);
      expect(env.FIRST).toBeUndefined();
      expect(env.BLOCKED).toBeUndefined();
      expect(env.FOREIGN).toBe("preserved");
    });
  });
});

describe("snapshot source authority", () => {
  it.each(
    (["dotenv", "env", "invalid-restore"] as const).flatMap((boundary) =>
      [false, true].map((revoked) => ({ boundary, revoked })),
    ),
  )("preserves reader authority at $boundary (revoked=$revoked)", async ({ boundary, revoked }) => {
    await withTempHome(async (home) => {
      const dotenv = boundary === "dotenv";
      const envKey = `OPENCLAW_TEST_SNAPSHOT_${dotenv ? "DOTENV" : "ENV"}`;
      const configPath = await writeOpenClawConfig(
        home,
        dotenv
          ? { gateway: { mode: "local" } }
          : {
              env: { vars: { [envKey]: "config-value" } },
              gateway: { mode: "local", port: boundary === "env" ? 18789 : "invalid" },
            },
      );
      const checkEnv = async (env: NodeJS.ProcessEnv) => {
        const refusal = dotenv
          ? new Error("snapshot source owner changed")
          : { reason: "snapshot-source-changed" };
        let current = true;
        let produced: { value: string | undefined } | undefined;
        const io = snapshotIO({
          configPath,
          env,
          measure: dotenv
            ? undefined
            : async (name, run) => {
                if (boundary === "env" && name === "config.snapshot.read.env") {
                  await Promise.resolve();
                  produced = { value: env[envKey] };
                  current = !revoked;
                  try {
                    return await run();
                  } catch (error) {
                    throw new Error("measurement replaced the authority refusal", {
                      cause: error,
                    });
                  }
                }
                const result = await run();
                if (
                  boundary === "invalid-restore" &&
                  name === "config.snapshot.read.legacy-issues"
                ) {
                  produced = { value: env[envKey] };
                  if (revoked) {
                    env[envKey] = "replacement-owner";
                    current = false;
                  }
                }
                return result;
              },
        });
        const checkRead = async (read: Promise<unknown>) => {
          if (revoked) {
            await expect(read).rejects.toBe(refusal);
          } else {
            await expect(read).resolves.toMatchObject({ valid: boundary !== "invalid-restore" });
          }
        };
        const read = withConfigWriteLock(
          configPath,
          async () => {
            if (dotenv) {
              current = !revoked;
              await checkRead(io.readConfigFileSnapshot());
              return undefined;
            }
            return (await io.readConfigFileSnapshotForWrite()).snapshot;
          },
          env,
          () => {
            if (!current) {
              // oxlint-disable-next-line typescript/only-throw-error -- Preserve non-Error authority refusals through measurement wrappers.
              throw refusal;
            }
          },
        );
        if (dotenv) {
          await read;
        } else {
          await checkRead(read);
        }
        if (!dotenv) {
          expect(produced).toEqual({ value: boundary === "env" ? undefined : "config-value" });
        }
        const accepted = dotenv ? "dotenv-value" : boundary === "env" ? "config-value" : undefined;
        const rejected = boundary === "invalid-restore" ? "replacement-owner" : undefined;
        expect(env[envKey]).toBe(revoked ? rejected : accepted);
      };
      if (dotenv) {
        const stateDir = path.dirname(configPath);
        await writeStateDirDotEnv(`${envKey}=dotenv-value\n`, { stateDir });
        await withEnvAsync(
          { [envKey]: undefined, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
          () => checkEnv(process.env),
        );
      } else {
        await checkEnv({ HOME: home });
      }
    });
  });
});
