import { vi } from "vitest";
import type { withSessionTranscriptDeltaReader } from "../../config/sessions/session-transcript-delta-read.js";
import { sessionWorkspaceMocks } from "./sessions-files.repository.test-support.js";

const fileMocks = vi.hoisted(() => ({ readDelta: vi.fn() }));
export const sessionFilesMocks = { ...sessionWorkspaceMocks, ...fileMocks };

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadIncognitoGatewaySessionEntryReadOnly: sessionWorkspaceMocks.loadSessionEntry,
}));

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    sessionWorkspaceMocks.loadSessionEntry(params.key, { agentId: params.agentId }),
}));

// mock-isolation: File-policy tests supply visible transcript pages without opening SQLite.
vi.mock("../../config/sessions/session-transcript-delta-read.js", () => ({
  withSessionTranscriptDeltaReader: ((scope, consume) =>
    consume({
      visible: async (limits) => fileMocks.readDelta(scope, limits),
      raw: async () => {
        throw new Error("File browsing must consume visible transcript pages");
      },
    })) satisfies typeof withSessionTranscriptDeltaReader,
}));
