import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  now: 1_800_000_000_000,
  uuid: "00000000-0000-4000-8000-000000000188",
  entries: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => fixture.uuid,
}));
vi.mock("../../src/plugin-state/plugin-state-store.ts", () => ({
  createPluginStateKeyedStore: () => ({ entries: fixture.entries }),
}));

const originalArgv = process.argv;
const smokeId = `acp-smoke-${fixture.now}-00000000`;
const ackToken = `ACP_SMOKE_ACK_${smokeId}`;
const binding = {
  threadId: "thread",
  targetSessionKey: "agent:codex:acp:synthetic",
  targetKind: "acp",
  agentId: "codex",
  boundAt: fixture.now,
};

afterEach(() => {
  process.argv = originalArgv;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Request = { method: string; path: string; authorization: string | null; body?: unknown };

async function runDriver(driver: "token" | "webhook", failure?: "identity" | "send") {
  vi.resetModules();
  fixture.entries.mockReset().mockResolvedValue([{ value: binding }]);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(fixture.now);
  const requests: Request[] = [];
  const sender = driver === "token" ? "driver-user" : "webhook-user";
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const incoming = new globalThis.Request(input, init);
      const url = new URL(incoming.url);
      const request = {
        method: incoming.method,
        path: `${url.pathname}${url.search}`.replace(/^\/api\/v10/u, ""),
        authorization: incoming.headers.get("Authorization"),
        ...(incoming.body === null ? {} : { body: await incoming.json() }),
      };
      requests.push(request);
      if (
        (failure === "identity" && request.path === "/users/@me") ||
        (failure === "send" &&
          (request.path === "/channels/parent/messages" || request.path.endsWith("?wait=true")))
      ) {
        return Response.json(
          { message: "synthetic refusal" },
          { status: 403, statusText: "Forbidden" },
        );
      }
      if (request.path === "/users/@me") {
        return Response.json({ id: "driver-user" });
      }
      if (request.path === "/channels/parent/webhooks") {
        return Response.json({ id: "webhook", token: "synthetic-webhook" });
      }
      if (request.method === "POST") {
        return Response.json({ id: "sent", author: { id: sender } });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      expect(request.path).toBe("/channels/thread/messages?limit=50");
      return Response.json([
        { id: "sender-copy", author: { id: sender }, content: ackToken },
        { id: "ack", author: { id: "agent-user", username: "Agent" }, content: ackToken },
      ]);
    }),
  );
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exited = new Error("synthetic process exit");
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  process.argv = [
    process.execPath,
    path.resolve("scripts/dev/discord-acp-plain-language-smoke.ts"),
    "--channel",
    "parent",
    "--driver",
    driver,
    "--token",
    "synthetic-driver",
    "--bot-token",
    "synthetic-bot",
    "--token-prefix",
    "Bot",
    "--bot-token-prefix",
    "Bot",
    "--agent",
    "codex",
    "--mention",
    "mentioned-user",
    "--instruction",
    "Synthetic ACP instruction",
    "--json",
  ];
  await expect(import("../../scripts/dev/discord-acp-plain-language-smoke.ts")).rejects.toBe(
    exited,
  );
  expect(exit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  return {
    requests,
    exitCode: exit.mock.calls[0]?.[0],
    stdout: stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    stderr: stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
  };
}

it.each(["token", "webhook"] as const)(
  "runs the %s driver through identity, send, binding and a different author's acknowledgement",
  async (driver) => {
    const result = await runDriver(driver);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify(
        {
          ok: true,
          smokeId,
          ackToken,
          sentMessageId: "sent",
          binding,
          ackMessage: {
            id: "ack",
            authorId: "agent-user",
            authorUsername: "Agent",
            content: ackToken,
          },
        },
        null,
        2,
      )}\n`,
    );
    const auth = `Bot synthetic-${driver === "token" ? "driver" : "bot"}`;
    const message = {
      content: "<@mentioned-user> Synthetic ACP instruction",
      allowed_mentions: { parse: [], users: ["mentioned-user"] },
    };
    expect(result.requests).toEqual([
      { method: "GET", path: "/users/@me", authorization: auth },
      ...(driver === "webhook"
        ? [
            {
              method: "POST",
              path: "/channels/parent/webhooks",
              authorization: auth,
              body: { name: "openclaw-acp-smoke-00000000" },
            },
          ]
        : []),
      {
        method: "POST",
        path:
          driver === "token"
            ? "/channels/parent/messages"
            : "/webhooks/webhook/synthetic-webhook?wait=true",
        authorization: driver === "token" ? auth : null,
        body: message,
      },
      { method: "GET", path: "/channels/thread/messages?limit=50", authorization: auth },
      ...(driver === "webhook"
        ? [
            {
              method: "DELETE",
              path: "/webhooks/webhook/synthetic-webhook",
              authorization: null,
            },
          ]
        : []),
    ]);
  },
);

it.each(["token", "webhook"] as const)(
  "reports %s identity failure before any send",
  async (driver) => {
    const result = await runDriver(driver, "identity");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      stage: "discord-api",
      smokeId,
      error: 'Discord API GET /users/@me failed: 403 Forbidden :: {"message":"synthetic refusal"}',
    });
    expect(
      result.requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`),
    ).toEqual(["GET /users/@me"]);
    expect(fixture.entries).not.toHaveBeenCalled();
  },
);

it("cleans up the temporary webhook after a send failure", async () => {
  const result = await runDriver("webhook", "send");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, stage: "send-message", smokeId });
  expect(
    result.requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`),
  ).toEqual([
    "GET /users/@me",
    "POST /channels/parent/webhooks",
    "POST /webhooks/webhook/synthetic-webhook?wait=true",
    "DELETE /webhooks/webhook/synthetic-webhook",
  ]);
  expect(fixture.entries).not.toHaveBeenCalled();
});
