import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519SignerFromSeed } from "../../../../packages/openclaw-id-protocol/src/index.js";
import { observeMainThreadFs } from "../../../test-utils/main-thread-fs-spies.test-support.js";
import {
  ed25519PublicKeyHex,
  KeyFileRefusedError,
  loadBoundKey,
  loadOrCreateEndpointKey,
  stagedKeyPath,
} from "./keyfile.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function keyPath() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-id-key-"));
  return path.join(dir, "iroh", "endpoint.key");
}

describe("tunnel endpoint key file", () => {
  it("creates a 0600 key once and loads the same key afterwards", async () => {
    const file = keyPath();
    using filesystem = observeMainThreadFs();
    const [created, concurrent] = await Promise.all([
      loadOrCreateEndpointKey(file),
      loadOrCreateEndpointKey(file),
    ]);
    expect(concurrent).toEqual({ key: created.key, created: false });
    expect(created.created).toBe(true);
    expect(created.key).toHaveLength(32);
    if (process.platform !== "win32") {
      expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
    }
    const loaded = await loadOrCreateEndpointKey(file);
    expect(loaded).toEqual({ key: created.key, created: false });
    expect(filesystem.calls()).toEqual({});
  });

  it.skipIf(process.platform === "win32")(
    "refuses a group-readable key instead of replacing it",
    async () => {
      const file = keyPath();
      await loadOrCreateEndpointKey(file);
      fs.chmodSync(file, 0o640);
      await expect(loadOrCreateEndpointKey(file)).rejects.toThrow(KeyFileRefusedError);
      expect(fs.readFileSync(file)).toHaveLength(32);
    },
  );

  it("refuses a corrupt key", async () => {
    const file = keyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "short", { mode: 0o600 });
    await expect(loadOrCreateEndpointKey(file)).rejects.toThrow(KeyFileRefusedError);
  });
});

describe("key rule for a linked claw", () => {
  const pubHex = (key: Buffer) => ed25519PublicKeyHex(key);

  it("derives the same public key as the protocol signer", async () => {
    const { key: seed } = await loadOrCreateEndpointKey(keyPath());
    const signer = await ed25519SignerFromSeed(seed);
    expect(pubHex(seed)).toBe(Buffer.from(signer.publicKey).toString("hex"));
  });

  it("uses the key file that holds the bound key and keeps a staged key", async () => {
    const file = keyPath();
    const { key } = await loadOrCreateEndpointKey(file);
    const { key: staged } = await loadOrCreateEndpointKey(stagedKeyPath(file));
    expect(await loadBoundKey(file, pubHex(key))).toEqual({ key, promoted: false });
    expect(fs.readFileSync(stagedKeyPath(file))).toEqual(staged);
  });

  it("promotes a staged key that holds the bound key", async () => {
    const file = keyPath();
    await loadOrCreateEndpointKey(file);
    const { key: next } = await loadOrCreateEndpointKey(stagedKeyPath(file));
    {
      using filesystem = observeMainThreadFs();
      expect(await loadBoundKey(file, pubHex(next))).toEqual({ key: next, promoted: true });
      expect(filesystem.calls()).toEqual({});
    }
    expect(fs.readFileSync(file)).toEqual(next);
    expect(fs.existsSync(stagedKeyPath(file))).toBe(false);
  });

  it("refuses a missing key and creates nothing", async () => {
    const file = keyPath();
    const bound = pubHex((await loadOrCreateEndpointKey(file)).key);
    fs.rmSync(file);
    expect(await loadBoundKey(file, bound)).toEqual({ refused: "keys_missing" });
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it("refuses another key and never promotes a planted staged key", async () => {
    const file = keyPath();
    const bound = pubHex(
      (await loadOrCreateEndpointKey(path.join(path.dirname(file), "elsewhere.key"))).key,
    );
    const { key: other } = await loadOrCreateEndpointKey(file);
    const { key: planted } = await loadOrCreateEndpointKey(stagedKeyPath(file));
    expect(await loadBoundKey(file, bound)).toEqual({ refused: "key_mismatch" });
    expect(fs.readFileSync(file)).toEqual(other);
    expect(fs.readFileSync(stagedKeyPath(file))).toEqual(planted);
  });
});
