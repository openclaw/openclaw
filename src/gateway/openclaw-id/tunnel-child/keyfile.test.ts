import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519SignerFromSeed } from "../../../../packages/openclaw-id-protocol/src/index.js";
import {
  createKeyFile,
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
  it("creates a 0600 key once and loads the same key afterwards", () => {
    const file = keyPath();
    const created = loadOrCreateEndpointKey(file);
    expect(created.created).toBe(true);
    expect(created.key).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const loaded = loadOrCreateEndpointKey(file);
    expect(loaded).toEqual({ key: created.key, created: false });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a group-readable key instead of replacing it",
    () => {
      const file = keyPath();
      loadOrCreateEndpointKey(file);
      fs.chmodSync(file, 0o640);
      expect(() => loadOrCreateEndpointKey(file)).toThrow(KeyFileRefusedError);
      expect(fs.readFileSync(file)).toHaveLength(32);
    },
  );

  it("refuses a corrupt key", () => {
    const file = keyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "short", { mode: 0o600 });
    expect(() => loadOrCreateEndpointKey(file)).toThrow(KeyFileRefusedError);
  });
});

describe("key rule for a linked claw", () => {
  const pubHex = (key: Buffer) => ed25519PublicKeyHex(key);

  it("derives the same public key as the protocol signer", async () => {
    const seed = createKeyFile(keyPath());
    const signer = await ed25519SignerFromSeed(seed);
    expect(pubHex(seed)).toBe(Buffer.from(signer.publicKey).toString("hex"));
  });

  it("uses the key file that holds the bound key and keeps a staged key", () => {
    const file = keyPath();
    const key = createKeyFile(file);
    const staged = createKeyFile(stagedKeyPath(file));
    expect(loadBoundKey(file, pubHex(key))).toEqual({ key, promoted: false });
    expect(fs.readFileSync(stagedKeyPath(file))).toEqual(staged);
  });

  it("promotes a staged key that holds the bound key", () => {
    const file = keyPath();
    createKeyFile(file);
    const next = createKeyFile(stagedKeyPath(file));
    expect(loadBoundKey(file, pubHex(next))).toEqual({ key: next, promoted: true });
    expect(fs.readFileSync(file)).toEqual(next);
    expect(fs.existsSync(stagedKeyPath(file))).toBe(false);
  });

  it("refuses a missing key and creates nothing", () => {
    const file = keyPath();
    const bound = pubHex(createKeyFile(file));
    fs.rmSync(file);
    expect(loadBoundKey(file, bound)).toEqual({ refused: "keys_missing" });
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it("refuses another key and never promotes a planted staged key", () => {
    const file = keyPath();
    const bound = pubHex(createKeyFile(path.join(path.dirname(file), "elsewhere.key")));
    const other = createKeyFile(file);
    const planted = createKeyFile(stagedKeyPath(file));
    expect(loadBoundKey(file, bound)).toEqual({ refused: "key_mismatch" });
    expect(fs.readFileSync(file)).toEqual(other);
    expect(fs.readFileSync(stagedKeyPath(file))).toEqual(planted);
  });
});
