import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../packages/gateway-protocol/src/index.js";
import { ExpectedCliError } from "./failure-output.js";
import { registerStatusHealthSessionsCommands } from "./program/register.status-health-sessions.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));
vi.mock("./session-target.js", () => ({ callSessionTargetGateway: mocks.callGateway }));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

async function run(args: string) {
  const program = new Command().enablePositionalOptions();
  registerStatusHealthSessionsCommands(program);
  await program.parseAsync(args.split(" "), { from: "user" });
}

function host(threadIds: string[], options: Partial<SessionCatalogHost> = {}): SessionCatalogHost {
  return {
    hostId: "gateway:local",
    label: "Gateway",
    kind: "gateway",
    connected: true,
    sessions: threadIds.map((threadId) => ({
      threadId,
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
    })),
    ...options,
  };
}

function catalog(id: string, hosts: SessionCatalogHost[]) {
  return { id, label: id, capabilities: { continueSession: true, archive: true }, hosts };
}

const imported = {
  sessionKey: "agent:main:imported-session",
  importedItems: 2,
  totalItems: 2,
  complete: true,
  created: true,
};

describe("sessions import CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGateway.mockReset();
  });

  it("pages each catalog host, preserves source homes, and continues after row failure", async () => {
    mocks.callGateway
      .mockResolvedValueOnce({
        catalogs: [
          catalog("claude", [host(["first", "broken"], { nextCursor: "older" })]),
          catalog("codex", [
            host(["codex-thread"], {
              hostId: "node:desktop",
              kind: "node",
              sessions: [
                {
                  ...host(["codex-thread"]).sessions[0]!,
                  sourceHomeId: "work-home",
                  name: "  Native Codex title  ",
                },
              ],
            }),
          ]),
        ],
      })
      .mockResolvedValueOnce(imported)
      .mockRejectedValueOnce(new Error("Source is unavailable"))
      .mockResolvedValueOnce({ catalogs: [catalog("claude", [host(["last"])])] })
      .mockResolvedValueOnce({ ...imported, created: false, importedItems: 0 })
      .mockResolvedValueOnce({ ...imported, created: false, importedItems: 1 });

    await run(
      "sessions --agent work --json import --all --url ws://gateway.test --token test-token",
    );

    expect(mocks.callGateway.mock.calls.map(([params]) => params.method)).toEqual([
      "sessions.catalog.list",
      "sessions.catalog.import",
      "sessions.catalog.import",
      "sessions.catalog.list",
      "sessions.catalog.import",
      "sessions.catalog.import",
    ]);
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        request: {
          agentId: "work",
          catalogId: "claude",
          limitPerHost: 100,
          hostIds: ["gateway:local"],
          cursors: { "gateway:local": "older" },
        },
      }),
    );
    expect(mocks.callGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ url: "ws://gateway.test", token: "test-token" }),
        requiredScope: "operator.write",
        request: {
          catalogId: "codex",
          hostId: "node:desktop",
          threadId: "codex-thread",
          sourceHomeId: "work-home",
          displayName: "Native Codex title",
          agentId: "work",
        },
      }),
    );
    const output = JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      ok: false,
      operation: "import",
      results: [
        { threadId: "first", status: "imported", importedItems: 2 },
        { threadId: "broken", status: "failed", error: "Source is unavailable" },
        { threadId: "last", status: "unchanged", importedItems: 0 },
        { threadId: "codex-thread", status: "updated", importedItems: 1 },
      ],
      summary: { imported: 1, updated: 1, unchanged: 1, failed: 1 },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("imports visible partial rows while reporting listing errors and stopping stale paging", async () => {
    mocks.callGateway
      .mockResolvedValueOnce({
        catalogs: [
          {
            ...catalog("claude", [
              host(["visible"], {
                nextCursor: "stale-cursor",
                error: { code: "catalog_stale", message: "Host refresh failed" },
              }),
            ]),
            error: { code: "catalog_stale", message: "Showing the last successful page" },
          },
        ],
      })
      .mockResolvedValueOnce(imported);

    await run("sessions import --all --json");

    expect(mocks.callGateway.mock.calls.map(([params]) => params.method)).toEqual([
      "sessions.catalog.list",
      "sessions.catalog.import",
    ]);
    expect(JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      results: [
        { catalogId: "claude", status: "failed", error: "Showing the last successful page" },
        { hostId: "gateway:local", status: "failed", error: "Host refresh failed" },
        { threadId: "visible", status: "imported", importedItems: 2 },
      ],
      summary: { imported: 1, failed: 2 },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("honors the total dry-run limit without issuing writes or fetching another page", async () => {
    mocks.callGateway.mockResolvedValueOnce({
      catalogs: [catalog("claude", [host(["first", "second"], { nextCursor: "older" })])],
    });
    await run(
      "sessions import --all --catalog claude --host gateway:local --limit 1 --dry-run --json",
    );
    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: "sessions.catalog.list",
        request: { catalogId: "claude", hostIds: ["gateway:local"], limitPerHost: 1 },
      }),
    );
    expect(JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      dryRun: true,
      results: [{ threadId: "first", status: "would_import" }],
      summary: { wouldImport: 1, failed: 0 },
    });
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("imports an explicit locator and warns about bounded history in human output", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ...imported, complete: false, totalItems: 50_001 });
    await run(
      "sessions import claude thread --host gateway:local --source-home home --password test-password --timeout 90000",
    );
    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith({
      gateway: { url: undefined, token: undefined, password: "test-password" },
      method: "sessions.catalog.import",
      request: {
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread",
        sourceHomeId: "home",
      },
      requiredScope: "operator.write",
      timeoutMs: 90_000,
    });
    expect(mocks.runtime.log.mock.calls[0]?.[0]).toContain(
      "2 new / 50001 source items (incomplete:",
    );
    expect(mocks.runtime.log).toHaveBeenLastCalledWith(
      "1 imported; 0 updated; 0 unchanged; 0 failed.",
    );
  });

  it.each([
    {
      catalogId: "claude",
      hosts: [host([], { hostId: "gateway:other" }), host([])],
      expectedHost: "gateway:local",
    },
    {
      catalogId: "opencode",
      hosts: [host([], { hostId: "gateway:local", kind: "node" }), host([], { hostId: "gateway" })],
      expectedHost: "gateway",
    },
    {
      catalogId: "custom",
      hosts: [host([], { hostId: "node:desktop", kind: "node" })],
      expectedHost: undefined,
    },
    {
      catalogId: "custom",
      hosts: [host([], { hostId: "gateway:first" }), host([], { hostId: "gateway:second" })],
      expectedHost: undefined,
    },
  ])(
    "selects $expectedHost for $catalogId from $hosts",
    async ({ catalogId, hosts, expectedHost }) => {
      mocks.callGateway.mockResolvedValueOnce({ catalogs: [catalog(catalogId, hosts)] });
      if (expectedHost) {
        mocks.callGateway.mockResolvedValueOnce(imported);
      }
      await run(`sessions import ${catalogId} thread ${expectedHost ? "--agent work " : ""}--json`);
      if (expectedHost) {
        expect(mocks.callGateway).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            method: "sessions.catalog.list",
            request: { catalogId, agentId: "work", limitPerHost: 1 },
          }),
        );
        expect(mocks.callGateway).toHaveBeenLastCalledWith(
          expect.objectContaining({
            method: "sessions.catalog.import",
            request: { catalogId, threadId: "thread", hostId: expectedHost, agentId: "work" },
          }),
        );
        expect(mocks.runtime.exit).not.toHaveBeenCalled();
      } else {
        expect(mocks.callGateway).toHaveBeenCalledTimes(1);
        const output = JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0]));
        expect(output).toMatchObject({ ok: false, results: [{ status: "failed" }] });
        expect(output.results[0].error).toContain("Pass --host <hostId>");
        expect(mocks.runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      }
    },
  );

  it.each([
    "sessions import --all claude thread",
    "sessions import claude",
    "sessions import --all --limit 0",
    "sessions import --all --source-home home",
    "sessions import claude thread --catalog codex",
  ])("rejects invalid selection: %s", async (args) => {
    await expect(run(args)).rejects.toBeInstanceOf(ExpectedCliError);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
