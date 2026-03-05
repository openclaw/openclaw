import type { ErrorShape } from "./protocol/index.js";

export type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};
