import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { sessionsLifecycleCommand } from "./sessions-lifecycle.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  confirm: vi.fn(),
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

// mock-isolation: Session lifecycle fixtures supply config without reading operator state.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  loadConfig: mocks.getRuntimeConfig,
  captureRuntimeConfigAsyncReader:
    (...args: Parameters<typeof mocks.getRuntimeConfig>) =>
    async () =>
      mocks.getRuntimeConfig(...args),
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ confirm: mocks.confirm }),
}));

function described(key: string, sessionId: string, extra = {}) {
  return { session: { key, sessionId, ...extra } };
}

function deleted(key: string, extra = {}) {
  return { ok: true, key, deleted: true, ...extra };
}

function failure(key: string, error: unknown, status = "failed") {
  return { key, ok: false, status, error };
}

function failedDelete(results: unknown[]) {
  return {
    ok: false,
    error: {
      type: "cli_error",
      message: "Session delete did not complete for every requested key.",
    },
    operation: "delete",
    dryRun: false,
    results,
  };
}

describe("sessions lifecycle commands", () => {
  let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;
  const run = (
    operation: Parameters<typeof sessionsLifecycleCommand>[0],
    options: Parameters<typeof sessionsLifecycleCommand>[1],
  ) => sessionsLifecycleCommand(operation, options, runtime);
  const expectJson = (payload: unknown) =>
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);

  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createNonExitingRuntimeEnv();
    mocks.confirm.mockResolvedValue(true);
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { entries: { main: {}, work: {} } },
    });
  });

  it.each([
    ["ghost", "agent:ghost:main", 'Unknown agent id "ghost"'],
    ["   ", "agent:main:main", "--agent must not be blank"],
  ])("delete rejects invalid agent %j before contacting the gateway", async (agent, key, error) => {
    await run("delete", { keys: [key], agent, json: true, yes: true });
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expectJson(
      expect.objectContaining({
        ok: false,
        results: [expect.objectContaining({ error: expect.stringContaining(error) })],
      }),
    );
  });

  it("archives through sessions.patch and emits the stable JSON envelope", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(described("agent:work:scratch-1", "session-1"))
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:work:scratch-1",
        entry: { archivedAt: 123 },
      });

    await run("archive", {
      keys: ["agent:work:scratch-1"],
      agent: "work",
      url: "ws://gateway.test",
      token: "test-token",
      password: "test-password",
      timeout: "45000",
      json: true,
    });

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
    expectJson({
      ok: true,
      operation: "archive",
      dryRun: false,
      results: [{ key: "agent:work:scratch-1", ok: true, status: "archived" }],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses archived state for a mutation-free archive dry run", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(described("agent:main:active", "active-session"))
      .mockResolvedValueOnce(
        described("agent:main:archived", "archived-session", { archived: true }),
      );

    await run("archive", {
      keys: ["agent:main:active", "agent:main:archived"],
      dryRun: true,
      json: true,
    });

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expectJson({
      ok: true,
      operation: "archive",
      dryRun: true,
      results: [
        { key: "agent:main:active", ok: true, status: "would_archive" },
        { key: "agent:main:archived", ok: true, status: "already_archived" },
      ],
    });
  });

  it.each([
    ["archive", "Cannot archive an agent's main session."],
    ["delete", "Cannot delete the main session (agent:work:gateway-main)."],
  ] as const)(
    "%s previews use Gateway main facts without treating global as protected",
    async (operation, error) => {
      mocks.getRuntimeConfig.mockReturnValue({
        agents: { entries: { work: {} } },
        session: { mainKey: "main", scope: "global" },
      });
      mocks.callGateway
        .mockResolvedValueOnce(
          described("agent:work:gateway-main", "main-session", { isMain: true }),
        )
        .mockResolvedValueOnce(described("agent:work:main", "ordinary-session", { isMain: false }))
        .mockResolvedValueOnce(described("global", "global-session", { isMain: true }));

      await run(operation, {
        keys: ["agent:work:gateway-main", "agent:work:main", "global"],
        agent: "work",
        url: "ws://gateway.test",
        dryRun: true,
        json: true,
      });

      expect(mocks.callGateway).toHaveBeenCalledTimes(3);
      expect(mocks.confirm).not.toHaveBeenCalled();
      expectJson(
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
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("rejects a key-only listed session before delete mutation", async () => {
    mocks.callGateway.mockResolvedValueOnce({ session: { key: "agent:main:key-only" } });

    await run("delete", { keys: ["agent:main:key-only"], yes: true, json: true });

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expectJson(
      failedDelete([
        failure(
          "agent:main:key-only",
          "Session has no durable identity; lifecycle mutation was not attempted.",
        ),
      ]),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("deletes archived sessions once with the Control UI gates", async () => {
    const keys = ["agent:main:archived", " agent:main:archived "];
    const worktreePreserved = {
      id: "wt-1",
      branch: "scratch",
      path: "/worktree",
      reason: "owner-mismatch",
    };
    onTestFinished(() => {
      mocks.callGateway.mockReset();
    });
    mocks.callGateway
      .mockResolvedValueOnce(
        described("agent:main:archived", "session-1", { agentId: "main", archived: true }),
      )
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:archived",
        deleted: true,
        archived: ["/state/session-1.jsonl.deleted.123"],
        worktreePreserved,
      })
      .mockResolvedValueOnce({ ok: true, key: "agent:main:archived", deleted: false });

    await run("delete", { keys, yes: true, json: true });

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
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
    expectJson({
      ok: true,
      operation: "delete",
      dryRun: false,
      results: [
        {
          key: "agent:main:archived",
          ok: true,
          status: "deleted",
          archived: ["/state/session-1.jsonl.deleted.123"],
          worktreePreserved,
        },
      ],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps requested owners when described sessions share a canonical key", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(described("global", "work-session", { agentId: "work" }))
      .mockResolvedValueOnce(described("global", "peer-session", { agentId: "peer" }))
      .mockResolvedValueOnce(deleted("global", { archived: ["/work/archive"] }))
      .mockResolvedValueOnce(deleted("global", { archived: ["/peer/archive"] }));

    await run("delete", { keys: ["agent:work:main", "agent:peer:main"], yes: true });

    for (const [index, agentId] of ["work", "peer"].entries()) {
      expect(mocks.callGateway).toHaveBeenNthCalledWith(
        index + 3,
        "sessions.delete",
        expect.any(Object),
        {
          key: `agent:${agentId}:main`,
          expectedSessionId: `${agentId}-session`,
          deleteTranscript: true,
        },
        { defaultTimeoutMs: 10 * 60_000 },
      );
    }
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("openclaw memory forget --agent work --session global"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("openclaw memory forget --agent peer --session global"),
    );
  });

  it("keeps client target hints out of Gateway-host cleanup", async () => {
    const url = "ws://gateway.test";
    vi.stubEnv("OPENCLAW_PROFILE", "client-profile");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "client-container");
    const key = "agent:work:notes;echo unsafe";
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { entries: { main: {}, work: {} } },
      gateway: { mode: "remote", remote: { url: "ws://configured-gateway.test" } },
    });
    mocks.callGateway
      .mockResolvedValueOnce(described(key, "session-1", { agentId: "work" }))
      .mockResolvedValueOnce(deleted(key, { archived: ["/gateway/archive"] }));

    await run("delete", { keys: [key], yes: true, url });

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
  });

  it.each([false, true])(
    "escapes lifecycle display values without changing JSON (%s)",
    async (json) => {
      const key = "agent:work:notes\u001b[2J\nnext";
      const archived = "/gateway/notes\u001b]2;changed\u0007\rnext";
      mocks.callGateway
        .mockResolvedValueOnce(described(key, "session-1", { agentId: "work" }))
        .mockResolvedValueOnce(deleted(key, { archived: [archived] }));

      await run("delete", { keys: [key], yes: true, json });

      expect(mocks.callGateway).toHaveBeenLastCalledWith(
        "sessions.delete",
        expect.any(Object),
        { key, expectedSessionId: "session-1", deleteTranscript: true },
        expect.any(Object),
      );
      if (json) {
        expectJson({
          ok: true,
          operation: "delete",
          dryRun: false,
          results: [{ key, ok: true, status: "deleted", archived: [archived] }],
        });
        return;
      }
      const output = vi.mocked(runtime.log).mock.calls.flat().join("\n");
      expect(output).toContain("Deleted session agent:work:notes\\nnext.");
      expect(output).toContain("Archived transcript: /gateway/notes\\rnext");
      for (const control of ["\u0007", "\u001b", "\r"]) {
        expect(output).not.toContain(control);
      }
      expect(output).not.toContain("\nnext");
    },
  );

  it("does not guess an owner when the Gateway omits its optional agent field", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(described("unknown", "session-1"))
      .mockResolvedValueOnce(deleted("unknown", { archived: ["/archive"] }));

    await run("delete", { keys: ["unknown"], yes: true });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "select the owning agent with --agent and this session with --session",
      ),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("--agent main"));
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("prints the preserved worktree cleanup reason without claiming source changes", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(described("agent:main:active", "session-1"))
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

    await run("delete", { keys: ["agent:main:active"], yes: true });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("cleanup did not finish normally"),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringMatching(/uncommitted|unpushed/i));
  });

  it("refuses non-interactive deletion without --yes", async () => {
    mocks.callGateway.mockResolvedValueOnce(described("agent:main:active", "session-1"));
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    try {
      await run("delete", { keys: ["agent:main:active"] });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
    }

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Pass --yes to delete non-interactively"),
    );
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("delete continues past rejected lookups and reports mixed results in order", async () => {
    onTestFinished(() => {
      mocks.callGateway.mockReset();
    });
    mocks.callGateway
      .mockResolvedValueOnce(described("agent:main:first", "session-1"))
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: 'malformed session key "agent:"',
        }),
      )
      .mockResolvedValueOnce({ session: null })
      .mockResolvedValueOnce(described("agent:main:last", "session-2"))
      .mockResolvedValueOnce(
        deleted("agent:main:first", { archived: ["/state/session-1.jsonl.deleted.123"] }),
      )
      .mockRejectedValueOnce(new Error("session is still active"));

    await run("delete", {
      keys: ["agent:main:first", "agent:", "agent:main:missing", "agent:main:last"],
      yes: true,
      json: true,
    });

    expectJson(
      failedDelete([
        {
          key: "agent:main:first",
          ok: true,
          status: "deleted",
          archived: ["/state/session-1.jsonl.deleted.123"],
        },
        failure("agent:", 'malformed session key "agent:"'),
        failure(
          "agent:main:missing",
          expect.stringContaining("openclaw sessions list --json"),
          "not_found",
        ),
        failure("agent:main:last", "session is still active"),
      ]),
    );
    expect(mocks.callGateway).toHaveBeenCalledTimes(6);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("delete preserves command-wide CLI errors during lookup", async () => {
    const error = new ExpectedCliError({
      message: "Gateway connection requires authentication",
      humanOutput: "Configure Gateway authentication before retrying.",
      machineOutput: "Gateway authentication required",
    });
    mocks.callGateway
      .mockResolvedValueOnce(described("agent:main:first", "session-1"))
      .mockRejectedValueOnce(error);

    await expect(
      run("delete", { keys: ["agent:main:first", "agent:main:last"], yes: true, json: true }),
    ).rejects.toBe(error);

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("treats a delete race that reports deleted:false as not found", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(described("agent:main:vanished", "session-1"))
      .mockResolvedValueOnce({ ok: true, key: "agent:main:vanished", deleted: false });

    await run("delete", { keys: ["agent:main:vanished"], yes: true, json: true });

    expectJson(
      failedDelete([
        failure("agent:main:vanished", expect.stringContaining("choose a valid key"), "not_found"),
      ]),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
