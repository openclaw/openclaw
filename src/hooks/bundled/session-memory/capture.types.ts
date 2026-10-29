import type { SessionMemoryProjection } from "./transcript.js";

export type SessionMemoryTranscript =
  | ({ status: "available" } & (SessionMemoryProjection | { content: null; originClass: "agent" }))
  | { status: "unavailable"; reason: string };
