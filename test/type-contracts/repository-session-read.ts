import { expectTypeOf } from "vitest";
import type { createRepositorySessionReadHost } from "../../src/gateway/control-ui-session-pr-runtime.js";
import type { RepositorySessionReads } from "../../src/gateway/repository-session-read.types.js";

// The concrete service retains inferred operations; its public contract must match all of them.
type Host = ReturnType<typeof createRepositorySessionReadHost>;
type InferredReads = Omit<ReturnType<Host["bindService"]>, "withRequestRead">;
expectTypeOf<RepositorySessionReads>().toEqualTypeOf<InferredReads>();
expectTypeOf<InferredReads>().toEqualTypeOf<RepositorySessionReads>();
