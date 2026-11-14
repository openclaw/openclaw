import { hashes } from "@noble/ed25519";

export { getPublicKeyAsync, signAsync } from "@noble/ed25519";

// Insecure contexts cannot use WebCrypto for the fallback's SHA-512 digest.
const subtleSha512Async = hashes.sha512Async;
hashes.sha512Async = async (message: Uint8Array) => {
  if (globalThis.crypto?.subtle && subtleSha512Async) {
    return await subtleSha512Async(message);
  }
  return Uint8Array.from((await import("@noble/hashes/sha2.js")).sha512(message));
};
