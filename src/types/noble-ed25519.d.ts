declare module "@noble/ed25519" {
  export function getPublicKeyAsync(privateKey: Uint8Array): Promise<Uint8Array>;
  export function signAsync(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>;
  export const utils: {
    randomSecretKey(): Uint8Array;
  };
}
