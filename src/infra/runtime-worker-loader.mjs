// Resolve the source-only loader inside the worker, never on the spawning thread.
await import(import.meta.resolve("tsx/esm"));
