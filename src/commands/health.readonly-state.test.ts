// Health read-path regression covers fresh hosts without creating shared state.
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const callGateway = vi.fn(async () => ({
  ok: true,
  ts: 1,
  durationMs: 1,
  channels: {},
  channelOrder: [],
  channelLabels: {},
  heartbeatSeconds: 0,
  defaultAgentId: "main",
  agents: [],
  sessions: { path: "", count: 0, recent: [] },
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway,
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

const { healthCommand } = await import("./health.js");

describe("health shared-state access", () => {
  it("reports health on a fresh host without creating or migrating the shared database", async () => {
    await withOpenClawTestState(
      { label: "health-readonly-state", layout: "state-only", scenario: "minimal" },
      async (state) => {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
          writeJson: vi.fn(),
          writeStdout: vi.fn(),
        };

        expect(fs.existsSync(databasePath)).toBe(false);
        await healthCommand({ json: true, timeoutMs: 100 }, runtime);

        expect(callGateway).toHaveBeenCalledOnce();
        expect(fs.existsSync(databasePath)).toBe(false);
        expect(runtime.writeJson).toHaveBeenCalledOnce();
      },
    );
  });
});
