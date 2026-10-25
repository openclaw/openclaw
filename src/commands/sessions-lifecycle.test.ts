import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { createNonExitingRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { sessionsCompactCommand } from "./sessions-compact.js";
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
vi.mock("../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("./test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "getRuntimeConfig"),
  };
});

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

function result(key: string, status: string, extra = {}) {
  return { key, ok: true, status, ...extra };
}

function respond(...values: unknown[]) {
  for (const value of values) {
    mocks.callGateway.mockResolvedValueOnce(value);
  }
}

function prepareDelete(key: string, extra = {}, session = {}) {
  respond(described(key, "session-1", session), deleted(key, extra));
}

describe("sessions lifecycle commands", () => {
  let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;
  const run = (
    operation: Parameters<typeof sessionsLifecycleCommand>[0],
    options: Parameters<typeof sessionsLifecycleCommand>[1],
  ) => sessionsLifecycleCommand(operation, options, runtime);
  const expectJson = (payload: unknown) =>
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
  const expectSuccess = (operation: string, results: unknown[], dryRun = false) =>
    expectJson({ ok: true, operation, dryRun, results });
  const expectMutation = (index: number, method: string, params: unknown) =>
    expect(mocks.callGateway).toHaveBeenNthCalledWith(index, method, expect.any(Object), params, {
      defaultTimeoutMs: 10 * 60_000,
    });
  const joinedArgs = (channel: "log" | "error") =>
    vi
      .mocked(runtime[channel])
      .mock.calls.map((call) => String(call[0]))
      .join("\n");

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
    const key = "agent:work:scratch-1";
    respond(described(key, "session-1"), { ok: true, key, entry: { archivedAt: 123 } });

    await run("archive", {
      keys: [key],
      agent: "work",
      url: "ws://gateway.test",
      token: "test-token",
      password: "test-password",
      timeout: "45000",
      json: true,
    });

    expectMutation(2, "sessions.patch", {
      key,
      agentId: "work",
      expectedSessionId: "session-1",
      archived: true,
    });
    expectSuccess("archive", [result(key, "archived")]);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses archived state for a mutation-free archive dry run", async () => {
    respond(
      described("agent:main:active", "active-session"),
      described("agent:main:archived", "archived-session", { archived: true }),
    );

    await run("archive", {
      keys: ["agent:main:active", "agent:main:archived"],
      dryRun: true,
      json: true,
    });

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expectSuccess(
      "archive",
      [
        result("agent:main:active", "would_archive"),
        result("agent:main:archived", "already_archived"),
      ],
      true,
    );
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
      respond(
        described("agent:work:gateway-main", "main-session", { isMain: true }),
        described("agent:work:main", "ordinary-session", { isMain: false }),
        described("global", "global-session", { isMain: true }),
      );

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
    const key = "agent:main:archived";
    const worktreePreserved = {
      id: "wt-1",
      branch: "scratch",
      path: "/worktree",
      reason: "owner-mismatch",
    };
    onTestFinished(() => {
      mocks.callGateway.mockReset();
    });
    const extra = { archived: ["/state/session-1.jsonl.deleted.123"], worktreePreserved };
    respond(described(key, "session-1", { agentId: "main", archived: true }), deleted(key, extra), {
      ok: true,
      key,
      deleted: false,
    });

    await run("delete", { keys: [key, ` ${key} `], yes: true, json: true });

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expectMutation(2, "sessions.delete", {
      key,
      expectedSessionId: "session-1",
      deleteTranscript: true,
      archivedOnly: true,
    });
    expectSuccess("delete", [result(key, "deleted", extra)]);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps requested owners when described sessions share a canonical key", async () => {
    respond(
      described("global", "work-session", { agentId: "work" }),
      described("global", "peer-session", { agentId: "peer" }),
      deleted("global", { archived: ["/work/archive"] }),
      deleted("global", { archived: ["/peer/archive"] }),
    );

    await run("delete", { keys: ["agent:work:main", "agent:peer:main"], yes: true });

    for (const [index, agentId] of ["work", "peer"].entries()) {
      expectMutation(index + 3, "sessions.delete", {
        key: `agent:${agentId}:main`,
        expectedSessionId: `${agentId}-session`,
        deleteTranscript: true,
      });
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining(`openclaw memory forget --agent ${agentId} --session global`),
      );
    }
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
    prepareDelete(key, { archived: ["/gateway/archive"] }, { agentId: "work" });

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
      prepareDelete(key, { archived: [archived] }, { agentId: "work" });

      await run("delete", { keys: [key], yes: true, json });

      expect(mocks.callGateway).toHaveBeenLastCalledWith(
        "sessions.delete",
        expect.any(Object),
        { key, expectedSessionId: "session-1", deleteTranscript: true },
        expect.any(Object),
      );
      if (json) {
        expectSuccess("delete", [result(key, "deleted", { archived: [archived] })]);
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
    prepareDelete("unknown", { archived: ["/archive"] });

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
    prepareDelete("agent:main:active", {
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

  describe("sessionsCompactCommand", () => {
    const compact = (
      opts: Parameters<typeof sessionsCompactCommand>[0] = { key: "agent:main:main" },
    ) => sessionsCompactCommand(opts, runtime);

    it.each(["compacted", "pending", "noop", "failed", "throw"])(
      "escapes terminal controls in %s output without changing RPC input",
      async (outcome) => {
        const key = "agent:main:notes\u001b[2J\nnext";
        const reason = "detail\u001b]2;changed\u0007\rnext";
        if (outcome === "throw") {
          mocks.callGateway.mockRejectedValueOnce(new Error(reason));
        } else {
          respond({
            ok: outcome !== "failed",
            key,
            compacted: outcome === "compacted",
            reason,
            result: { details: { pending: outcome === "pending" } },
          });
        }
        await compact({ key });
        expect(mocks.callGateway.mock.calls[0]?.[2]).toEqual({ key });
        const output = `${joinedArgs("log")}${joinedArgs("error")}`;
        for (const control of ["\u0007", "\u001b", "\r", "\n"]) {
          expect(output).not.toContain(control);
        }
        if (outcome !== "throw") {
          expect(output).toContain("agent:main:notes\\nnext");
        }
        if (["noop", "failed", "throw"].includes(outcome)) {
          expect(output).toContain("detail\\rnext");
        }
        if (["failed", "throw"].includes(outcome)) {
          expect(runtime.exit).toHaveBeenCalledWith(1);
          expect(joinedArgs("error")).toContain("Compaction failed");
        }
        if (outcome === "pending") {
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(output).toContain("pending");
          expect(output).not.toContain("No compaction needed");
        }
      },
    );

    it("preserves raw result values in JSON output", async () => {
      const payload = {
        ok: false,
        key: "agent:main:notes\u001b[2J\nnext",
        reason: "detail\u001b]2;changed\u0007\rnext",
      };
      respond(payload);
      await compact({ key: payload.key, json: true });
      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(payload, 2);
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });

    it("rejects a blank agent before calling the Gateway", async () => {
      await expect(compact({ key: "agent:main:main", agent: "" })).rejects.toThrow(
        "--agent must not be blank",
      );
      expect(mocks.callGateway).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "prints successful compaction and its degradation warning (%s)",
      async (qualityDegraded) => {
        respond({
          ok: true,
          key: "agent:main:main",
          compacted: true,
          result: { tokensBefore: 243868, tokensAfter: 34941, details: { qualityDegraded } },
        });
        await compact();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(mocks.callGateway.mock.calls[0]?.[1]).toMatchObject({ timeout: null });
        const logged = joinedArgs("log");
        expect(logged).toContain("243868");
        expect(logged).toContain("34941");
        expect(logged.includes("degraded summary")).toBe(qualityDegraded);
      },
    );

    it("exits non-zero when the gateway response omits explicit success", async () => {
      respond({ key: "agent:main:main", compacted: false });
      await compact();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(joinedArgs("error")).toContain("Compaction failed");
    });

    it("forwards agentId and maxLines to the RPC params", async () => {
      respond({ ok: true, key: "agent:work:main", compacted: true, kept: 200 });
      await compact({ key: "agent:work:main", agent: "work", maxLines: 200 });
      expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
        "sessions.compact",
        expect.anything(),
        { key: "agent:work:main", agentId: "work", maxLines: 200 },
        expect.anything(),
      );
    });
  });
});
