import { vi } from "vitest";
import type { CronCreatorSessionLookup } from "./cron-creator-session.test-support.js";

const loadGatewaySessionEntry = vi.hoisted(() =>
  vi.fn<(sessionKey: string, options?: { agentId?: string }) => CronCreatorSessionLookup>(
    (sessionKey) => ({ canonicalKey: sessionKey, entry: undefined }),
  ),
);

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: loadGatewaySessionEntry,
  loadGatewaySessionEntryReadOnly: loadGatewaySessionEntry,
}));

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    loadGatewaySessionEntry(params.key, { agentId: params.agentId }),
}));

export { loadGatewaySessionEntry };
