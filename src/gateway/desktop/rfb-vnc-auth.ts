import { createCipheriv } from "node:crypto";

function reverseByteBits(value: number): number {
  let input = value;
  let output = 0;
  for (let index = 0; index < 8; index += 1) {
    output = (output << 1) | (input & 1);
    input >>= 1;
  }
  return output;
}

/** RFB VncAuth response. Single DES is the wire primitive shared by preauth and probes. */
export function buildVncAuthResponse(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "utf8").copy(key, 0, 0, 8);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = reverseByteBits(key[index] ?? 0);
  }
  // EDE with K1=K2 matches DES-ECB on OpenSSL builds that omit des-ecb.
  const cipher = createCipheriv("des-ede", Buffer.concat([key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}
