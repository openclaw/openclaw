import { vi } from "vitest";

const readPin = vi.hoisted(() =>
  vi.fn<typeof import("../daemon/runtime-pin-state.js").readDaemonRuntimePinForInstall>(),
);
// mock-isolation: Service-planning fixtures replace pin admission without opening stores or native locks.
vi.mock("../daemon/runtime-pin-state.js", () => ({
  readDaemonRuntimePinForInstall: readPin,
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, read: () => T): Promise<T> =>
    read(),
}));

export { readPin };
