import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { isNodeError } from "@openclaw/fs-safe/path";
import { root } from "../infra/fs-safe.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { PWA_ICON_MAX_BYTES, PWA_ICON_SIZES, type PwaIconSize } from "./pwa-icon-contract.js";

const MAX_SLOTS = 128;
const MAX_PROFILE_SLOTS = 8;
export type PwaIconRasters = Record<PwaIconSize, Buffer>;

export function createPwaIconStore(directory: string) {
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
  const load = async () => {
    const slots = new Map<string, string>();
    const tokens = new Set<string>();
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { slots, tokens };
      }
      throw error;
    }
    const dir = await getDirectory();
    // The atomic .slot pointer is the commit record; don't load any image data at startup.
    for (const name of files) {
      if (!/^[0-9a-f]{64}\.[0-9a-f]{64}\.slot$/u.test(name)) {
        continue;
      }
      const token = (await dir.read(name, { maxBytes: 64 })).buffer.toString("utf8");
      if (!/^[0-9a-f]{64}$/u.test(token) || tokens.has(token) || slots.size >= MAX_SLOTS) {
        throw new Error("Invalid PWA icon directory");
      }
      slots.set(name, token);
      tokens.add(token);
      registerSecretValueForRedaction(token);
    }
    // A shutdown between rendering and pointer publication/retirement can leave unreferenced PNGs.
    for (const name of files) {
      const match = /^([0-9a-f]{64})\.(512|192|180)\.png$/u.exec(name);
      if (match && !tokens.has(match[1]!)) {
        await dir.remove(name);
      }
    }
    return { slots, tokens };
  };
  let ready: ReturnType<typeof load> | undefined;
  const prepare = () =>
    (ready ??= load().catch((error: unknown) => {
      ready = undefined;
      throw error;
    }));
  let writing = false;
  return {
    async has(token: string) {
      return (await prepare()).tokens.has(token);
    },
    async read(token: string, size: PwaIconSize) {
      const { tokens } = await prepare();
      if (!tokens.has(token)) {
        return undefined;
      }
      try {
        const { buffer } = await (
          await getDirectory()
        ).read(`${token}.${size}.png`, { maxBytes: PWA_ICON_MAX_BYTES });
        return tokens.has(token) ? buffer : undefined;
      } catch (error) {
        if (tokens.has(token)) {
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
        const { slots, tokens } = await prepare();
        const owner = createHash("sha256").update(profileId).digest("hex") + ".";
        const slot = `${owner}${device}.slot`;
        const previous = slots.get(slot);
        if (!previous && !rasters) {
          return { status: "ok" } as const;
        }
        const dir = await getDirectory();
        let token: string | undefined;
        if (rasters) {
          if (
            !previous &&
            (slots.size >= MAX_SLOTS ||
              [...slots.keys()].filter((k) => k.startsWith(owner)).length >= MAX_PROFILE_SLOTS)
          ) {
            return { status: "full" } as const;
          }
          token = randomBytes(32).toString("hex");
          registerSecretValueForRedaction(token);
          try {
            for (const size of PWA_ICON_SIZES) {
              await dir.write(`${token}.${size}.png`, rasters[size], { mode: 0o600 });
            }
            await dir.write(slot, token, { mode: 0o600 });
          } catch (error) {
            for (const size of PWA_ICON_SIZES) {
              await dir.remove(`${token}.${size}.png`, { force: true });
            }
            throw error;
          }
          slots.set(slot, token);
          tokens.add(token);
        } else if (previous) {
          await dir.remove(slot);
          slots.delete(slot);
        }
        if (previous) {
          tokens.delete(previous);
          for (const size of PWA_ICON_SIZES) {
            await dir.remove(`${previous}.${size}.png`);
          }
        }
        return { status: "ok", token } as const;
      } finally {
        writing = false;
      }
    },
  };
}
