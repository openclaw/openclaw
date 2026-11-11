import { expectTypeOf } from "vitest";
import type {
  spawnTerminalPty,
  TerminalPtyHandle,
  TerminalPtySpawnParams,
} from "../../src/plugin-sdk/process-runtime.js";

// Preserve the PTY call contract shipped in v2026.9.8.
type ReleasedSpawn = (
  params: TerminalPtySpawnParams,
  lifecycle?: { abortSignal?: AbortSignal; assertCurrent?: () => void },
) => Promise<TerminalPtyHandle>;
expectTypeOf<typeof spawnTerminalPty>().toExtend<ReleasedSpawn>();
expectTypeOf<ReturnType<typeof spawnTerminalPty>>().toEqualTypeOf<Promise<TerminalPtyHandle>>();
