// The trusted synchronous preload owns this callback; the main entry runs after user preloads.
export const entry: unknown = Reflect.get(
  globalThis,
  Symbol.for("openclaw.pluginSnapshotChildEntry"),
);
if (typeof entry !== "function") {
  throw new Error("Plugin snapshot child did not initialize its verified loader");
}
await entry();
