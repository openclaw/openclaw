// Keep the media mock separate from the general runtime fixture's line-cap budget.
import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export type PluginRuntimeMediaMock = PluginRuntime["channel"]["media"];

const TEST_SAVED_MEDIA = {
  id: "test-media.jpg",
  path: "/tmp/test-media.jpg",
  size: 0,
  contentType: "image/jpeg",
} satisfies Awaited<ReturnType<PluginRuntimeMediaMock["saveMediaBuffer"]>>;

export function createPluginRuntimeMediaMock(
  overrides: Partial<PluginRuntimeMediaMock> = {},
): PluginRuntimeMediaMock {
  const readRemoteMediaBuffer = vi.fn<PluginRuntimeMediaMock["readRemoteMediaBuffer"]>();
  return {
    readRemoteMediaBuffer,
    fetchRemoteMedia: readRemoteMediaBuffer,
    saveRemoteMedia: vi
      .fn<PluginRuntimeMediaMock["saveRemoteMedia"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    saveResponseMedia: vi
      .fn<PluginRuntimeMediaMock["saveResponseMedia"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    saveMediaBuffer: vi
      .fn<PluginRuntimeMediaMock["saveMediaBuffer"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    deleteMediaBuffer: vi.fn<PluginRuntimeMediaMock["deleteMediaBuffer"]>().mockResolvedValue(),
    ...overrides,
  };
}
