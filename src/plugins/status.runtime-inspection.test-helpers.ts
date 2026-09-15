import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

export function createDiagnosticsFixture(state: OpenClawTestState, cleanupThrows = false) {
  const id = "diagnostics-resource";
  const event = `diagnostics-resource-${path.basename(state.root)}`;
  const rootDir = state.path("plugin");
  const disposed = state.path("disposed.txt");
  fs.mkdirSync(rootDir);
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: id,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.ts"] },
    }),
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: { type: "object", properties: {} },
    }),
  );
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    `
    import fs from "node:fs";
    export default { id: ${JSON.stringify(id)}, register(api) {
      const listener = () => {};
      process.on(${JSON.stringify(event)}, listener);
      api.lifecycle.onDispose(() => {
        process.removeListener(${JSON.stringify(event)}, listener);
        fs.appendFileSync(${JSON.stringify(disposed)}, "disposed\\n");
        ${cleanupThrows ? 'throw new Error("fixture cleanup rejected");' : ""}
      });
      api.registerService({
        get id() { api.lifecycle.signal.throwIfAborted(); return "diagnostics-resource-service"; },
        start() {}, stop() {},
      });
    } };
  `,
  );
  const config: OpenClawConfig = {
    commands: { text: true, plugins: true },
    agents: { defaults: { workspace: state.workspaceDir } },
    plugins: {
      enabled: true,
      allow: [id],
      load: { paths: [rootDir] },
      entries: { [id]: { enabled: true } },
      slots: { memory: "none" },
    },
  };
  return { id, event, config, disposed };
}

export function classifyConfigObservationError(error: unknown) {
  const errorNames = [
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "AggregateError",
  ];
  const errorCodes = [
    "ERR_SQLITE_ERROR",
    "ERR_INVALID_STATE",
    "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    "PLUGIN_CACHE_FACT_INVALIDATED",
    "EACCES",
    "EPERM",
    "ENOENT",
    "EBUSY",
    "EMFILE",
    "ENFILE",
    "ENOSPC",
    "EROFS",
  ];
  const classified = {
    errorName: "<other>",
    errorCode: "<other-or-absent>",
    messageKind: "detail-withheld",
    stackOwners: [] as string[],
  };
  try {
    const errorName = error instanceof Error ? error.name : undefined;
    const errorCode =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    classified.errorName = errorNames.find((name) => name === errorName) ?? "<other>";
    classified.errorCode = errorCodes.find((code) => code === errorCode) ?? "<other-or-absent>";
    const message = error instanceof Error ? error.message : undefined;
    classified.messageKind =
      [
        ["OpenClaw state database read admission is closed", "state-read-admission-closed"],
        ["OpenClaw state database read admission changed", "state-read-admission-changed"],
        ["Config health observation was superseded", "health-observation-superseded"],
      ].find(([knownMessage]) => knownMessage === message)?.[1] ?? "detail-withheld";
    const stack = error instanceof Error ? error.stack : undefined;
    if (typeof stack === "string") {
      const frames = stack.split("\n").filter((line) => /^\s+at /.test(line));
      const stackOwners: [string, RegExp][] = [
        ["io-observe", /[\\/]src[\\/]config[\\/]io\.observe\.(?:ts|js):\d+:\d+\)?$/],
        ["io-health-state", /[\\/]src[\\/]config[\\/]io\.health-state\.(?:ts|js):\d+:\d+\)?$/],
        [
          "state-db-async-lifecycle",
          /[\\/]src[\\/]state[\\/]openclaw-state-db-async-lifecycle\.(?:ts|js):\d+:\d+\)?$/,
        ],
      ];
      classified.stackOwners = stackOwners
        .filter(([, pattern]) => frames.some((frame) => pattern.test(frame)))
        .map(([owner]) => owner);
    }
  } catch {
    // Error getters and classification must not replace the original failure.
  }
  return classified;
}
