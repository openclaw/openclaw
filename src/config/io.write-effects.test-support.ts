import fs from "node:fs";
import path from "node:path";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import {
  captureConfigFileWritePathProof,
  createConfigFileWriteGuard,
  rollbackConfigFileWriteIfUnchanged,
  type ConfigFileWriteRollbackProof,
} from "./io.write-safety.js";

export const original = '{"channel":"stable"}\n';
export const content = '{"channel":"beta"}\n';
type Fixture = ReturnType<typeof createWriteEffectsFixture>;
type WriteOptions = Pick<
  Parameters<typeof prepareConfigFileWrite>[0],
  "destinationHardlinks" | "durable"
>;

export function createWriteEffectsFixture(dir: string) {
  const target = path.join(dir, "channel.json");
  fs.writeFileSync(target, original);
  const proof = captureConfigFileWritePathProof(target, target, fs);
  const refusal = new Error("original executor revoked");
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw refusal;
    }
    proof.assertCurrent();
  };
  const options = {
    snapshot: { path: target, exists: true, raw: original },
    includeGraph: { hashes: {}, targets: {} },
    targetPathProof: proof,
    preserveDirectoryMode: true,
  };
  return {
    dir,
    target,
    assertCurrent,
    refusal,
    options,
    backups: () =>
      ["", ".1", ".2", ".3", ".4"].map((suffix) => {
        try {
          return fs.readFileSync(`${target}.bak${suffix}`, "utf8");
        } catch {
          return null;
        }
      }),
    rollback: (
      io: typeof fs,
      rollbackProof: ConfigFileWriteRollbackProof,
      overrides: Partial<Parameters<typeof rollbackConfigFileWriteIfUnchanged>[0]> = {},
    ) =>
      rollbackConfigFileWriteIfUnchanged({
        configPath: target,
        previousSnapshot: options.snapshot,
        committedHash: hashConfigRaw(content),
        fsModule: io,
        ...rollbackProof,
        ...overrides,
      }),
    revoke: () => (current = false),
  };
}

export async function prepareWriteEffects(
  f: Fixture,
  io: typeof fs = fs,
  options: Parameters<typeof createConfigFileWriteGuard>[3] = f.options,
  assertCurrent = f.assertCurrent,
  writeOptions: WriteOptions = { destinationHardlinks: "reject", durable: true },
) {
  const guarded = createConfigFileWriteGuard(f.target, io, assertCurrent, options);
  const prepared = await prepareConfigFileWrite({
    configPath: f.target,
    previousRaw: original,
    content,
    fsModule: guarded.fileSystem,
    assertCurrent: guarded.assertCurrent,
    assertBeforeMutation: guarded.assertBeforeMutation,
    onDestinationState: guarded.onDestinationState,
    ...writeOptions,
  });
  return { guarded, prepared };
}

export async function prepareClosedWrite(f: Fixture, publish = true) {
  const { prepared, guarded } = await prepareWriteEffects(f);
  await using pending = prepared;
  if (publish) {
    pending.publish();
  }
  return guarded;
}

/** Observe real exclusive-open destination effects without changing other descriptors. */
export function instrumentDestination(
  io: typeof fs,
  target: string,
  hooks: {
    open?: (fd: number) => void;
    write?: () => void;
    chunkSize?: number;
    closeOnOpenError?: boolean;
  },
): typeof fs {
  let destinationFd: number | undefined;
  return {
    ...io,
    openSync(name, flags, mode) {
      const fd = io.openSync(name, flags, mode);
      try {
        if (String(name) === target && typeof flags === "number" && flags & fs.constants.O_EXCL) {
          destinationFd = fd;
          hooks.open?.(fd);
        }
        return fd;
      } catch (error) {
        if (hooks.closeOnOpenError) {
          try {
            io.closeSync(fd);
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              "Native replacement injection and descriptor close failed",
              { cause: closeError },
            );
          }
        }
        throw error;
      }
    },
    writeSync: new Proxy(io.writeSync, {
      apply(fn, self, args) {
        const destination = args[0] === destinationFd;
        if (destination && hooks.chunkSize !== undefined) {
          args[3] = Math.min(args[3], hooks.chunkSize);
        }
        const result = Reflect.apply(fn, self, args);
        if (destination) {
          hooks.write?.();
        }
        return result;
      },
    }),
  };
}
