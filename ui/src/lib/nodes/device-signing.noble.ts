import { hashes } from "@noble/ed25519";

export { getPublicKeyAsync, signAsync } from "@noble/ed25519";

// Insecure contexts cannot use WebCrypto for the fallback's SHA-512 digest.
const subtleSha512Async = hashes.sha512Async;
hashes.sha512Async = async (message: Uint8Array) => {
  if (globalThis.crypto?.subtle && subtleSha512Async) {
    return await subtleSha512Async(message);
  }
  const { sha512 } = await import("@noble/hashes/sha2.js");
  return Uint8Array.from(sha512(message));
};
