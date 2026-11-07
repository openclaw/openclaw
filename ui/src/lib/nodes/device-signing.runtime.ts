import { hashes } from "@noble/ed25519";

export { getPublicKeyAsync, signAsync } from "@noble/ed25519";

// Keep the signer and its insecure-context fallback behind the first signing
// operation. Reading stored credentials does not need either implementation.
const subtleSha512Async = hashes.sha512Async;
hashes.sha512Async = async (message: Uint8Array) => {
  if (globalThis.crypto?.subtle && subtleSha512Async) {
    return await subtleSha512Async(message);
  }
  return Uint8Array.from((await import("@noble/hashes/sha2.js")).sha512(message));
};
