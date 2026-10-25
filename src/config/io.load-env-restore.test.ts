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
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
  withConfigReadEnvChanges,
} from "./config-env-vars.js";
import { createConfigIO } from "./io.js";
import type { ConfigIoFactoryOptions } from "./io.types.js";
import { getConfigResolutionFacts } from "./resolution-facts.js";
import { withTempHome, writeOpenClawConfig, writeStateDirDotEnv } from "./test-helpers.js";
import { withConfigWriteLock } from "./write-lock.js";

function configIO(home: string, env: NodeJS.ProcessEnv, lowerPrecedenceEnv?: NodeJS.ProcessEnv) {
  return createConfigIO({
    env,
    lowerPrecedenceEnv,
    homedir: () => home,
    logger: { warn: () => {}, error: () => {} },
  });
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

it.each(["ownership", "value"])("preserves later %s during snapshot compensation", (change) => {
  const env: NodeJS.ProcessEnv = {};
  const before = snapshotEnv(env);
  applyConfigEnvVars(configEnv("candidate"), env);
  const after = snapshotEnv(env);
  if (change === "ownership") {
    applyConfigEnvVars({}, env);
  } else {
    env.KEY = "foreign";
  }
  restoreEnvChangesIfUnchanged({ env, before, after });
  expect(env.KEY).toBe(change === "ownership" ? "candidate" : "foreign");
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

  it.each(["ambient", "config", "absent"])(
    "restores synchronous env changes after DuplicateAgentDirError (%s)",
    async (ownership) => {
      await withTempHome(async (home) => {
        const owned = ownership === "config";
        await writeOpenClawConfig(home, {
          env: { vars: { KEY: owned ? "replacement" : "same" } },
          agents: {
            ownership: "explicit",
            entries: {
              "agent-a": { agentDir: "/tmp/dup-agent-dir" },
              "agent-b": { agentDir: "/tmp/dup-agent-dir" },
            },
          },
        });

        const env: NodeJS.ProcessEnv = {
          HOME: home,
          ...(ownership === "ambient" && { KEY: "same" }),
        };
        const previous = configEnv("same");
        if (owned) {
          applyConfigEnvVars(previous, env);
        }
        const io = configIO(home, env, { KEY: "same" });
        expect(() => io.loadConfig()).toThrow(DuplicateAgentDirError);
        expect(env.KEY).toBe(ownership === "absent" ? undefined : "same");
        expect(createConfigRuntimeEnvBase(previous, env).KEY).toBe(
          ownership === "ambient" ? "same" : undefined,
        );
      });
    },
  );
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
      let produced: (string | undefined)[] | undefined;
      const io = snapshotIO({
        configPath,
        env,
        lowerPrecedenceEnv: { [ownedKey]: lower },
        measure: async (name, run) => {
          const result = await run();
          if (name === "config.snapshot.read.legacy-issues") {
            produced = [
              Object.keys(env).find((key) => key.toUpperCase() === ownedKey),
              env[originalKey],
              createConfigRuntimeEnvBase({ env: cfg.env }, env)[ownedKey],
            ];
            env[native ? addedKey.toLowerCase() : addedKey] = "new-owner";
            delete env[native ? deletedKey.toLowerCase() : deletedKey];
            changeOwned(env, originalKey, change);
          }
          return result;
        },
      });
      const { snapshot } = await io.readConfigFileSnapshotForWrite();
      expect([snapshot.valid, produced]).toEqual([false, [ownedKey, value, undefined]]);
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

  it.each([false, true])(
    "restores rejected snapshot ownership (previous config=%s)",
    async (owned) => {
      await withTempHome(async (home) => {
        const previous = configEnv("same");
        const cfg = { ...configEnv(owned ? "replacement" : "same"), gateway: { port: "invalid" } };
        const configPath = await writeOpenClawConfig(home, cfg);
        const env: NodeJS.ProcessEnv = { HOME: home };
        if (owned) {
          applyConfigEnvVars(previous, env);
        } else {
          env.KEY = "same";
        }
        const io = snapshotIO({
          configPath,
          env,
          lowerPrecedenceEnv: { KEY: "same" },
        });
        expect((await io.readConfigFileSnapshot()).valid).toBe(false);
        expect(env.KEY).toBe("same");
        expect(createConfigRuntimeEnvBase(previous, env).KEY).toBe(owned ? undefined : "same");
      });
    },
  );

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
      expect([env.FIRST, env.BLOCKED, env.FOREIGN]).toEqual([undefined, undefined, "preserved"]);
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
      const configPath = await writeOpenClawConfig(home, {
        ...(!dotenv && { env: { vars: { [envKey]: "config-value" } } }),
        gateway: { mode: "local", ...(boundary === "invalid-restore" && { port: "invalid" }) },
      });
      const checkEnv = async (env: NodeJS.ProcessEnv) => {
        const refusal = dotenv
          ? new Error("snapshot source owner changed")
          : { reason: "snapshot-source-changed" };
        let current = true;
        const produced: Array<string | undefined> = [];
        const io = snapshotIO({
          configPath,
          env,
          measure: dotenv
            ? undefined
            : async (name, run) => {
                if (boundary === "env" && name === "config.snapshot.read.env") {
                  await Promise.resolve();
                  produced.push(env[envKey]);
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
                  produced.push(env[envKey]);
                  if (revoked) {
                    env[envKey] = "replacement-owner";
                    current = false;
                  }
                }
                return result;
              },
        });
        const read = withConfigWriteLock(
          configPath,
          async () => {
            if (dotenv) {
              current = !revoked;
              return io.readConfigFileSnapshot();
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
        if (revoked) {
          await expect(read).rejects.toBe(refusal);
        } else {
          await expect(read).resolves.toMatchObject({ valid: boundary !== "invalid-restore" });
        }
        expect(produced).toEqual(dotenv ? [] : [boundary === "env" ? undefined : "config-value"]);
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
