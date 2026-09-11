import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsArchiveCommand, sessionsDeleteCommand } from "./sessions-lifecycle.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  confirm: vi.fn(),
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ confirm: mocks.confirm }),
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

function listResult(
  sessions: Array<{
    key: string;
    sessionId?: string;
    agentId?: string;
    archived?: boolean;
    isMain?: boolean;
  }>,
  pagination: { hasMore?: boolean; nextOffset?: number | null } = {},
) {
  return { sessions, hasMore: false, nextOffset: null, ...pagination };
}

describe("sessions lifecycle commands", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue(true);
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { entries: { main: {}, work: {} } },
    });
  });

  it.each([
    ["archive", sessionsArchiveCommand, {} as Record<string, unknown>],
    ["delete", sessionsDeleteCommand, { yes: true } as Record<string, unknown>],
  ])(
    "%s rejects an unconfigured --agent before contacting the gateway",
    async (_label, command, extra) => {
      const runtime = createRuntime();
      await command(
        { keys: ["agent:ghost:main"], agent: "ghost", json: true, ...extra } as never,
        runtime as never,
      );
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          results: [
            expect.objectContaining({
              error: expect.stringContaining('Unknown agent id "ghost"'),
            }),
          ],
        }),
        2,
      );
    },
  );

  it.each([
    ["archive", sessionsArchiveCommand, {} as Record<string, unknown>],
    ["delete", sessionsDeleteCommand, { yes: true } as Record<string, unknown>],
  ])("%s rejects a blank --agent", async (_label, command, extra) => {
    const runtime = createRuntime();
    await command(
      { keys: ["agent:main:main"], agent: "   ", json: true, ...extra } as never,
      runtime as never,
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        results: [
          expect.objectContaining({
            error: expect.stringContaining("--agent must not be blank"),
          }),
        ],
      }),
      2,
    );
  });

  it("archives through sessions.patch and emits the stable JSON envelope", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "agent:work:scratch-1", sessionId: "session-1" }]))
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:work:scratch-1",
        entry: { archivedAt: 123 },
      });
    const runtime = createRuntime();

    await sessionsArchiveCommand(
      {
        keys: ["agent:work:scratch-1"],
        agent: "work",
        url: "ws://gateway.test",
        token: "test-token",
        password: "test-password",
        timeout: "45000",
        json: true,
      },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      1,
      "sessions.list",
      {
        url: "ws://gateway.test",
        token: "test-token",
        password: "test-password",
        timeout: "45000",
        json: true,
      },
      {
        limit: 200,
        archived: "all",
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
        agentId: "work",
      },
      { defaultTimeoutMs: 30_000 },
    );
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      "sessions.patch",
      expect.any(Object),
      {
        key: "agent:work:scratch-1",
        agentId: "work",
        expectedSessionId: "session-1",
        archived: true,
      },
      { defaultTimeoutMs: 10 * 60_000 },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "archive",
        dryRun: false,
        results: [{ key: "agent:work:scratch-1", ok: true, status: "archived" }],
      },
      2,
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses sessions.list archived state for a mutation-free archive dry run", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      listResult([
        { key: "agent:main:active", sessionId: "active-session" },
        { key: "agent:main:archived", sessionId: "archived-session", archived: true },
      ]),
    );
    const runtime = createRuntime();

    await sessionsArchiveCommand(
      {
        keys: ["agent:main:active", "agent:main:archived"],
        dryRun: true,
        json: true,
      },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "archive",
        dryRun: true,
        results: [
          { key: "agent:main:active", ok: true, status: "would_archive" },
          { key: "agent:main:archived", ok: true, status: "already_archived" },
        ],
      },
      2,
    );
  });

  it.each([
    ["archive", sessionsArchiveCommand, "Cannot archive an agent's main session."],
    ["delete", sessionsDeleteCommand, "Cannot delete the main session (agent:work:gateway-main)."],
  ] as const)(
    "%s previews use Gateway main facts without treating global as protected",
    async (operation, command, error) => {
      mocks.getRuntimeConfig.mockReturnValue({
        agents: { entries: { work: {} } },
        session: { mainKey: "main", scope: "global" },
      });
      mocks.callGateway.mockResolvedValueOnce(
        listResult([
          { key: "agent:work:gateway-main", sessionId: "main-session", isMain: true },
          { key: "agent:work:main", sessionId: "ordinary-session", isMain: false },
          { key: "global", sessionId: "global-session", isMain: true },
        ]),
      );
      const runtime = createRuntime();

      await command(
        {
          keys: ["agent:work:gateway-main", "agent:work:main", "global"],
          agent: "work",
          url: "ws://gateway.test",
          dryRun: true,
          json: true,
        },
        runtime,
      );

      expect(mocks.callGateway).toHaveBeenCalledTimes(1);
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          operation,
          dryRun: true,
          results: [
            { key: "agent:work:gateway-main", ok: false, status: "failed", error },
            { key: "agent:work:main", ok: true, status: `would_${operation}` },
            { key: "global", ok: true, status: `would_${operation}` },
          ],
        }),
        2,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it.each([true, false])(
    "keeps archived main archive requests as no-ops (dryRun=%s)",
    async (dryRun) => {
      mocks.callGateway.mockResolvedValueOnce(
        listResult([
          { key: "agent:main:main", sessionId: "main-session", isMain: true, archived: true },
        ]),
      );
      const runtime = createRuntime();

      await sessionsArchiveCommand({ keys: ["agent:main:main"], dryRun, json: true }, runtime);

      expect(mocks.callGateway).toHaveBeenCalledTimes(1);
      expect(runtime.writeJson).toHaveBeenCalledWith(
        {
          ok: true,
          operation: "archive",
          dryRun,
          results: [{ key: "agent:main:main", ok: true, status: "already_archived" }],
        },
        2,
      );
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["archive", sessionsArchiveCommand, "sessions.patch", { archived: true }],
    ["delete", sessionsDeleteCommand, "sessions.delete", { deleteTranscript: true }],
  ] as const)(
    "leaves real main %s requests to the Gateway",
    async (_operation, command, method, params) => {
      mocks.callGateway
        .mockResolvedValueOnce(
          listResult([{ key: "agent:main:main", sessionId: "main-session", isMain: true }]),
        )
        .mockRejectedValueOnce(new Error("Gateway lifecycle refusal"));
      const runtime = createRuntime();

      await command({ keys: ["agent:main:main"], yes: true, json: true }, runtime);

      expect(mocks.callGateway).toHaveBeenCalledTimes(2);
      expect(mocks.callGateway).toHaveBeenNthCalledWith(
        2,
        method,
        expect.any(Object),
        { key: "agent:main:main", expectedSessionId: "main-session", ...params },
        { defaultTimeoutMs: 10 * 60_000 },
      );
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          results: [
            {
              key: "agent:main:main",
              ok: false,
              status: "failed",
              error: "Gateway lifecycle refusal",
            },
          ],
        }),
        2,
      );
    },
  );

  it.each([
    ["archive", sessionsArchiveCommand, {}],
    ["delete", sessionsDeleteCommand, { yes: true }],
  ] as const)(
    "rejects a key-only listed session before %s mutation",
    async (_operation, command, options) => {
      mocks.callGateway.mockResolvedValueOnce(listResult([{ key: "agent:main:key-only" }]));
      const runtime = createRuntime();

      await command({ keys: ["agent:main:key-only"], ...options, json: true }, runtime);

      expect(mocks.callGateway).toHaveBeenCalledTimes(1);
      expect(mocks.callGateway.mock.calls[0]?.[0]).toBe("sessions.list");
      expect(runtime.writeJson).toHaveBeenCalledWith(
        {
          ok: false,
          error: {
            type: "cli_error",
            message: `Session ${_operation} did not complete for every requested key.`,
          },
          operation: _operation,
          dryRun: false,
          results: [
            {
              key: "agent:main:key-only",
              ok: false,
              status: "failed",
              error: "Session has no durable identity; lifecycle mutation was not attempted.",
            },
          ],
        },
        2,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("deletes archived sessions with the same gated artifact contract as Control UI", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(
        listResult([
          { key: "agent:main:archived", sessionId: "session-1", agentId: "main", archived: true },
        ]),
      )
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:archived",
        deleted: true,
        archived: ["/state/session-1.jsonl.deleted.123"],
        worktreePreserved: {
          id: "wt-1",
          branch: "scratch",
          path: "/worktree",
          reason: "owner-mismatch",
        },
      });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:archived"], yes: true, json: true }, runtime);

    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      "sessions.delete",
      expect.any(Object),
      {
        key: "agent:main:archived",
        expectedSessionId: "session-1",
        deleteTranscript: true,
        archivedOnly: true,
      },
      { defaultTimeoutMs: 10 * 60_000 },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "delete",
        dryRun: false,
        results: [
          {
            key: "agent:main:archived",
            ok: true,
            status: "deleted",
            archived: ["/state/session-1.jsonl.deleted.123"],
            worktreePreserved: {
              id: "wt-1",
              branch: "scratch",
              path: "/worktree",
              reason: "owner-mismatch",
            },
          },
        ],
      },
      2,
    );
  });

  it.each([
    { key: "agent:main:active", canonicalKey: "agent:main:active", agentId: "main" },
    { key: "agent:work:active", canonicalKey: "agent:work:active", agentId: "work" },
    { key: "global", canonicalKey: "global", agentId: "work" },
    { key: "unknown", canonicalKey: "unknown", agentId: "work" },
    { key: "agent:work:main", canonicalKey: "global", agentId: "work" },
  ])(
    "targets the Gateway owner of $key when explaining retained memory",
    async ({ key, canonicalKey, agentId }) => {
      mocks.callGateway
        .mockResolvedValueOnce(listResult([{ key, sessionId: "session-1", agentId }]))
        .mockResolvedValueOnce({
          ok: true,
          key: canonicalKey,
          deleted: true,
          archived: ["/state/session-1.jsonl.deleted.123"],
        });
      const runtime = createRuntime();

      await sessionsDeleteCommand({ keys: [key], yes: true }, runtime);

      expect(runtime.log).toHaveBeenCalledWith(`Deleted session ${canonicalKey}.`);
      expect(runtime.log).toHaveBeenCalledWith(
        "Archived transcript: /state/session-1.jsonl.deleted.123",
      );
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Archived transcripts can remain eligible for memory search"),
      );
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining(
          `openclaw memory forget --agent ${agentId} --session ${canonicalKey} on the Gateway host or container using its state and configuration`,
        ),
      );
    },
  );

  it("keeps separate owners when delete responses share a canonical key", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(
        listResult([
          { key: "agent:work:main", sessionId: "work-session", agentId: "work" },
          { key: "agent:peer:main", sessionId: "peer-session", agentId: "peer" },
        ]),
      )
      .mockResolvedValueOnce({
        ok: true,
        key: "global",
        deleted: true,
        archived: ["/work/archive"],
      })
      .mockResolvedValueOnce({
        ok: true,
        key: "global",
        deleted: true,
        archived: ["/peer/archive"],
      });
    const runtime = createRuntime();

    await sessionsDeleteCommand(
      { keys: ["agent:work:main", "agent:peer:main"], yes: true },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("openclaw memory forget --agent work --session global"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("openclaw memory forget --agent peer --session global"),
    );
  });

  it.each([undefined, "ws://gateway.test"])(
    "keeps client target hints out of Gateway-host cleanup (url=%s)",
    async (url) => {
      vi.stubEnv("OPENCLAW_PROFILE", "client-profile");
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", "client-container");
      const key = "agent:work:notes;echo unsafe";
      mocks.getRuntimeConfig.mockReturnValue({
        agents: { entries: { main: { default: true }, work: {} } },
        gateway: { mode: "remote", remote: { url: "ws://configured-gateway.test" } },
      });
      mocks.callGateway
        .mockResolvedValueOnce(listResult([{ key, sessionId: "session-1", agentId: "work" }]))
        .mockResolvedValueOnce({ ok: true, key, deleted: true, archived: ["/gateway/archive"] });
      const runtime = createRuntime();

      await sessionsDeleteCommand({ keys: [key], yes: true, url }, runtime);

      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining(
          "openclaw memory forget --agent work --session 'agent:work:notes;echo unsafe' on the Gateway host or container using its state and configuration",
        ),
      );
      expect(runtime.log).not.toHaveBeenCalledWith(
        expect.stringContaining("--profile client-profile"),
      );
      expect(runtime.log).not.toHaveBeenCalledWith(
        expect.stringContaining("--container client-container"),
      );
    },
  );

  it("does not guess an owner when the Gateway omits its optional agent field", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "unknown", sessionId: "session-1" }]))
      .mockResolvedValueOnce({ ok: true, key: "unknown", deleted: true, archived: ["/archive"] });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["unknown"], yes: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "select the owning agent with --agent and this session with --session",
      ),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("--agent main"));
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("does not print memory forget guidance when no delete archive is retained", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "agent:main:active", sessionId: "session-1" }]))
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:active",
        deleted: true,
        archived: [],
      });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:active"], yes: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith("Deleted session agent:main:active.");
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("openclaw memory forget"));
  });

  it("prints the preserved worktree cleanup reason without claiming source changes", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "agent:main:active", sessionId: "session-1" }]))
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:active",
        deleted: true,
        archived: [],
        worktreePreserved: {
          id: "wt-1",
          branch: "openclaw/active",
          path: "/worktree",
          reason: "cleanup-failed",
        },
      });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:active"], yes: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("cleanup did not finish normally"),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringMatching(/uncommitted|unpushed/i));
  });

  it("deletes active sessions without the archive-only scope restriction", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "agent:main:active", sessionId: "session-1" }]))
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:active",
        deleted: true,
        archived: [],
      });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:active"], yes: true }, runtime);

    const deleteParams = mocks.callGateway.mock.calls[1]?.[2];
    expect(deleteParams).toEqual({
      key: "agent:main:active",
      expectedSessionId: "session-1",
      deleteTranscript: true,
    });
    expect(deleteParams).not.toHaveProperty("archivedOnly");
  });

  it("keeps delete dry runs read-only and does not require --yes", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      listResult([{ key: "agent:main:active", sessionId: "session-1" }]),
    );
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:active"], dryRun: true, json: true }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "delete",
        dryRun: true,
        results: [{ key: "agent:main:active", ok: true, status: "would_delete" }],
      },
      2,
    );
  });

  it("refuses non-interactive deletion without --yes", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      listResult([{ key: "agent:main:active", sessionId: "session-1" }]),
    );
    const runtime = createRuntime();
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    try {
      await sessionsDeleteCommand({ keys: ["agent:main:active"] }, runtime);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
    }

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(mocks.callGateway.mock.calls[0]?.[0]).toBe("sessions.list");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Pass --yes to delete non-interactively"),
    );
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("reports mixed valid and invalid keys in order and exits non-zero after continuing", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(
        listResult([
          { key: "agent:main:first", sessionId: "session-1" },
          { key: "agent:main:last", sessionId: "session-2" },
        ]),
      )
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:first",
        deleted: true,
        archived: ["/state/session-1.jsonl.deleted.123"],
      })
      .mockRejectedValueOnce(new Error("session is still active"));
    const runtime = createRuntime();

    await sessionsDeleteCommand(
      {
        keys: ["agent:main:first", "agent:main:missing", "agent:main:last"],
        yes: true,
        json: true,
      },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenCalledTimes(3);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: false,
        error: {
          type: "cli_error",
          message: "Session delete did not complete for every requested key.",
        },
        operation: "delete",
        dryRun: false,
        results: [
          {
            key: "agent:main:first",
            ok: true,
            status: "deleted",
            archived: ["/state/session-1.jsonl.deleted.123"],
          },
          {
            key: "agent:main:missing",
            ok: false,
            status: "not_found",
            error: expect.stringContaining("openclaw sessions list --json"),
          },
          {
            key: "agent:main:last",
            ok: false,
            status: "failed",
            error: "session is still active",
          },
        ],
      },
      2,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("treats a delete race that reports deleted:false as not found", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "agent:main:vanished", sessionId: "session-1" }]))
      .mockResolvedValueOnce({ ok: true, key: "agent:main:vanished", deleted: false });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:vanished"], yes: true, json: true }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: false,
        error: {
          type: "cli_error",
          message: "Session delete did not complete for every requested key.",
        },
        operation: "delete",
        dryRun: false,
        results: [
          {
            key: "agent:main:vanished",
            ok: false,
            status: "not_found",
            error: expect.stringContaining("choose a valid key"),
          },
        ],
      },
      2,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("paginates the UI list surface before declaring a key unknown", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([], { hasMore: true, nextOffset: 200 }))
      .mockResolvedValueOnce(listResult([{ key: "agent:main:later", sessionId: "session-2" }]));
    const runtime = createRuntime();

    await sessionsArchiveCommand({ keys: ["agent:main:later"], dryRun: true, json: true }, runtime);

    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      "sessions.list",
      expect.any(Object),
      expect.objectContaining({ offset: 200 }),
      { defaultTimeoutMs: 30_000 },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "archive",
        dryRun: true,
        results: [{ key: "agent:main:later", ok: true, status: "would_archive" }],
      },
      2,
    );
  });
});
