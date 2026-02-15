import crypto from "node:crypto";

export function validateMessengerSignature(
  body: string,
  signature: string,
  appSecret: string,
): boolean {
  const expectedPrefix = "sha256=";
  if (!signature.startsWith(expectedPrefix)) {
    return false;
  }

  const receivedHash = signature.slice(expectedPrefix.length);
  const computedHash = crypto.createHmac("sha256", appSecret).update(body).digest("hex");

  const receivedBuffer = Buffer.from(receivedHash, "hex");
  const computedBuffer = Buffer.from(computedHash, "hex");

  if (receivedBuffer.length !== computedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, computedBuffer);
}
