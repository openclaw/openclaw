import { randomUUID } from "node:crypto";

export function randomIdempotencyKey() {
  return randomUUID();
}
