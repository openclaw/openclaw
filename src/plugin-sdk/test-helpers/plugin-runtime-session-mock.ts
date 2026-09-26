import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

type SessionRuntime = PluginRuntime["agent"]["session"];

/** Builds the read-only session methods shared by plugin runtime test doubles. */
export function createPluginSessionReadRuntimeMock(): Pick<
  SessionRuntime,
  "getSessionEntry" | "getSessionEntryInWorker" | "listSessionEntries"
> {
  return {
    getSessionEntry: vi.fn<SessionRuntime["getSessionEntry"]>(() => undefined),
    getSessionEntryInWorker: vi
      .fn<SessionRuntime["getSessionEntryInWorker"]>()
      .mockResolvedValue(undefined),
    listSessionEntries: vi.fn<SessionRuntime["listSessionEntries"]>(() => []),
  };
}
