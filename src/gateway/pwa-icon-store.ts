import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { isNodeError } from "@openclaw/fs-safe/path";
import { root } from "../infra/fs-safe.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { PWA_ICON_MAX_BYTES, PWA_ICON_SIZES, type PwaIconSize } from "./pwa-icon-contract.js";

export type PwaIconRasters = Record<PwaIconSize, Buffer>;

export function createPwaIconStore(stateDir: string) {
  const directory = path.join(stateDir, "pwa-icons");
  const databasePath = resolveOpenClawStateSqlitePath({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  const openDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return root(directory);
  };
  let handle: ReturnType<typeof openDirectory> | undefined;
  const getDirectory = () =>
    (handle ??= openDirectory().catch((error: unknown) => {
      handle = undefined;
      throw error;
    }));

  // The Gateway is the only artwork writer. Hydrate its bounded public-token index
  // from committed rows; a crash on either side of commit can leave only orphan PNGs.
  const load = async () => {
    const reply = await executeExistingOpenClawStateRead(
      { path: databasePath },
      { type: "pwaIcon.tokens", input: undefined },
    );
    const tokens = new Set(reply?.tokens);
    for (const token of tokens) {
      registerSecretValueForRedaction(token);
    }
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return tokens;
      }
      throw error;
    }
    const dir = await getDirectory();
    for (const name of files) {
      const match = /^([0-9a-f]{64})\.(512|192|180)\.png$/u.exec(name);
      if (match && !tokens.has(match[1]!)) {
        await dir.remove(name, { force: true });
      }
    }
    return tokens;
  };
  let ready: ReturnType<typeof load> | undefined;
  const prepare = () =>
    (ready ??= load().catch((error: unknown) => {
      ready = undefined;
      throw error;
    }));
  const removeRasters = async (token: string) => {
    const dir = await getDirectory();
    for (const size of PWA_ICON_SIZES) {
      await dir.remove(`${token}.${size}.png`, { force: true });
    }
  };
  let writing = false;
  return {
    async has(token: string) {
      return (await prepare()).has(token);
    },
    async read(token: string, size: PwaIconSize) {
      if (!(await prepare()).has(token)) {
        return undefined;
      }
      try {
        const { buffer } = await (
          await getDirectory()
        ).read(`${token}.${size}.png`, { maxBytes: PWA_ICON_MAX_BYTES });
        return (await prepare()).has(token) ? buffer : undefined;
      } catch (error) {
        if ((await prepare()).has(token)) {
          throw error;
        }
        return undefined;
      }
    },
    async set(profileId: string, device: string, rasters: PwaIconRasters | null) {
      if (!/^[0-9a-f]{64}$/u.test(device)) {
        throw new Error("Invalid PWA icon device");
      }
      if (writing) {
        return { status: "busy" } as const;
      }
      writing = true;
      try {
        const tokens = await prepare();
        const context = captureOpenClawStateWorkerContext({ path: databasePath });
        const profileKey = createHash("sha256").update(profileId).digest("hex");
        const token = rasters && randomBytes(32).toString("hex");
        if (rasters && token) {
          registerSecretValueForRedaction(token);
          const dir = await getDirectory();
          for (const size of PWA_ICON_SIZES) {
            await dir.write(`${token}.${size}.png`, rasters[size], { mode: 0o600 });
          }
        }
        const change = await runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute({
              type: "pwaIcon.change",
              input: { profileKey, device, token },
            }),
          {
            createAdmission: createSqliteWorkerWriteAdmission(
              () => context.admission.assertCurrent(),
              [databasePath],
            ),
          },
        );
        if (change.status === "full") {
          if (token) {
            await removeRasters(token);
          }
          return change;
        }
        if (token) {
          tokens.add(token);
        }
        if (change.previous) {
          tokens.delete(change.previous);
          // Revocation is committed. A deferred file cleanup must not hide a successful receipt.
          try {
            await removeRasters(change.previous);
          } catch {
            ready = undefined; // Retry orphan cleanup from the canonical slot index on next use.
          }
        }
        return { status: "ok", token } as const;
      } catch (error) {
        // A lost worker reply is not proof of rollback. Reload the committed
        // index before the next read/write; only then reap any unreferenced PNGs.
        ready = undefined;
        throw error;
      } finally {
        writing = false;
      }
    },
  };
}
