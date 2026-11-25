// Native build tooling imports this declaration without a TypeScript resolver.
import { createRuntimeProcessEntrypoints } from "./runtime-process-manifest.ts";

export const SQLITE_READONLY_CHILD_ARG = "--openclaw-sqlite-readonly-child";

// Launchers keep this declaration boundary so compiled subprocesses resolve in their generation.
export const runtimeProcessEntrypoints = createRuntimeProcessEntrypoints(import.meta.url);
