import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const readRegistryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ entries: Array<{ backendId?: string }> }> => ({ entries: [] })),
);

vi.mock("../plugins/runtime/runtime-registry-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime/runtime-registry-loader.js")>()),
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

// mock-isolation: CLI startup controls sandbox entries without reading persisted SQLite state.
vi.mock("../agents/sandbox/registry.js", () => ({ readRegistry: readRegistryMock }));

let originalForceStderr: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  readRegistryMock.mockResolvedValue({ entries: [] });
  originalForceStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
});

afterEach(() => {
  loggingState.forceConsoleToStderr = originalForceStderr;
  vi.unstubAllEnvs();
});

// Overlap ordering is owned by json-output-mode.test.ts ("retains overlapping stderr scopes").
it.each([
  [false, true, false],
  [false, true, true],
  [true, true, false],
  [false, false, false],
] as const)(
  "restores stderr=%s (route=%s, reject=%s)",
  async (initial, routeLogsToStderr, reject) => {
    loggingState.forceConsoleToStderr = initial;
    const failure = new Error("Plugin activation failed");
    ensurePluginRegistryLoadedMock.mockImplementationOnce(async () => {
      expect(loggingState.forceConsoleToStderr).toBe(initial || routeLogsToStderr);
      if (reject) {
        throw failure;
      }
    });
    const result = ensureCliPluginRegistryLoaded({ scope: "all", routeLogsToStderr });
    if (reject) {
      await expect(result).rejects.toBe(failure);
    } else {
      await result;
    }
    expect(loggingState.forceConsoleToStderr).toBe(initial);
  },
);

it("includes persisted runtime owners when loading sandbox managers", async () => {
  readRegistryMock.mockResolvedValue({
    entries: [{ backendId: "openshell" }, { backendId: "docker" }, { backendId: "openshell" }],
  });

  const config = { plugins: { enabled: false } };
  await ensureCliPluginRegistryLoaded({ scope: "sandbox-management", config });

  expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
    scope: "sandbox-backends",
    config,
    persistedSandboxBackendIds: ["docker", "openshell"],
  });
});
