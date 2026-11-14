import { hashes, signAsync as signNoble } from "@noble/ed25519";

export { getPublicKeyAsync } from "@noble/ed25519";

// Insecure contexts cannot use WebCrypto for the fallback's SHA-512 digest.
const subtleSha512Async = hashes.sha512Async;
hashes.sha512Async = async (message: Uint8Array) => {
  if (globalThis.crypto?.subtle && subtleSha512Async) {
    return await subtleSha512Async(message);
  }
  return Uint8Array.from((await import("@noble/hashes/sha2.js")).sha512(message));
};

// Keep only this document's most recent identity; another seed must import its own key.
let signingKey: { seed: string; key: Promise<CryptoKey> } | undefined;

export async function signAsync(
  message: Uint8Array<ArrayBuffer>,
  seed: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const identity = seed.toHex();
      if (signingKey?.seed !== identity) {
        // RFC 8410 PKCS8 wraps the existing 32-byte Ed25519 seed without changing storage.
        const key = subtle.importKey(
          "pkcs8",
          Uint8Array.of(48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32, ...seed),
          { name: "Ed25519" },
          false,
          ["sign"],
        );
        signingKey = { seed: identity, key };
      }
      // WebKit may hedge signatures with randomness; the Gateway verifies the payload.
      return new Uint8Array(await subtle.sign({ name: "Ed25519" }, await signingKey.key, message));
    } catch {
      // Unsupported/failed native crypto uses the existing signer and its input errors.
      // A rejected import stays cached for this identity until the document ends.
    }
  }
  return signNoble(message, seed);
}
