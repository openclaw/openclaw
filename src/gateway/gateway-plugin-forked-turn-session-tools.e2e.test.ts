import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Fixture,
  type MethodResult,
  withForkGateway,
} from "./gateway-plugin-forked-turn.test-support.js";

describe("plugin forked turns with the session's read, ls and exec", () => {
  it(
    "lets a fork read, ls and run owner exec under the session's own policy, never asking",
    { timeout: 180_000 },
    async () => {
      await withForkGateway(
        (config) => ({
          ...config,
          tools: {
            ...config.tools,
            exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: false },
          },
        }),
        async (fixture) => {
          const settled = { ok: true, result: { status: "settled" } };
          const coreTools = { tools: ["read", "ls", "exec"] };
          const owner = await fixture.dashboardTurn(
            `agent:main:dashboard:direct:fork-core-${randomUUID()}`,
          );
          // read runs; write stays listed for the cache but returns a refusal; owner exec runs.
          fixture.forkScript.calls = [
            { name: "read", args: { path: "notes.txt" } },
            { name: "write", args: { path: "fork-wrote.txt", content: "x" } },
            { name: "exec", args: { command: "echo FORK_EXEC_RAN" } },
          ];
          await expect(fixture.fork(owner, coreTools)).resolves.toMatchObject(settled);
          const [read, write, exec] = fixture.forkToolOutputs();
          expect(read).toContain("Release notes.");
          expect(write).toContain("write is not available in this background run");
          expect(exec).toContain("FORK_EXEC_RAN");
          await expect(
            fs.access(path.join(fixture.workspaceDir, "fork-wrote.txt")),
          ).rejects.toThrow();

          // Without `through`, the fork reads through the session's latest message.
          fixture.forkScript.calls = [{ name: "ls", args: { path: "." } }];
          await expect(
            fixture.fork(owner, { ...coreTools, through: undefined }),
          ).resolves.toMatchObject(settled);
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("notes.txt")]);

          // A full writer through a session-scoped method gets the same fork.
          fixture.forkScript.calls = [{ name: "exec", args: { command: "echo OWN_EXEC_RAN" } }];
          await expect(fixture.ownFork(owner.sessionKey, coreTools.tools)).resolves.toMatchObject(
            settled,
          );
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("OWN_EXEC_RAN")]);

          // A non-owner's turn keeps read, but a request with exec is refused before any model call.
          const stranger = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-core-7-${randomUUID()}`,
            "7",
          );
          const strangerForkCalls = fixture.forkRequests.length;
          await expect(fixture.fork(stranger, coreTools)).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });
          expect(fixture.forkRequests).toHaveLength(strangerForkCalls);
          fixture.forkScript.calls = [{ name: "read", args: { path: "notes.txt" } }];
          await expect(fixture.fork(stranger, { tools: ["read", "ls"] })).resolves.toMatchObject(
            settled,
          );
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("Release notes.")]);

          // An unmatched command under allowlist/on-miss is denied without an approval request.
          await fixture.patchConfig({ tools: { exec: { security: "allowlist", ask: "on-miss" } } });
          fixture.forkScript.calls = [{ name: "exec", args: { command: "touch fork-made.txt" } }];
          await expect
            .poll(
              async () => {
                await fixture.fork(owner, coreTools);
                return fixture.forkToolOutputs()[0];
              },
              { timeout: 30_000, interval: 500 },
            )
            .toContain("approval_required");
          await expect(
            fs.access(path.join(fixture.workspaceDir, "fork-made.txt")),
          ).rejects.toThrow();
          await expect(fixture.client.request("exec.approval.list", {})).resolves.toEqual([]);

          // A manifest claim on a core tool id grants nothing: exec stays under the session's
          // own profile, and other core-built ids are refused.
          const claim = (tools: string[]) =>
            fixture.client.request<MethodResult>(
              "forkclaim.run",
              {
                sessionKey: owner.sessionKey,
                through: { sessionId: owner.sessionId, entryId: owner.entryId },
                tools,
              },
              { timeoutMs: 120_000 },
            );
          // Core builds these, with or without a factory family; neither may be claimed.
          for (const tool of ["write", "skills_read"]) {
            await expect(claim([tool])).resolves.toMatchObject({
              ok: false,
              message: expect.stringContaining(`may not add core tool "${tool}"`),
            });
          }
          const forkCalls = fixture.forkRequests.length;
          await fixture.patchConfig({ tools: { profile: "messaging" } });
          await expect
            .poll(async () => claim(["exec"]), { timeout: 30_000, interval: 500 })
            .toEqual({ ok: true, result: { status: "refused", reason: "tool_policy" } });
          expect(fixture.forkRequests).toHaveLength(forkCalls);
        },
        { claimPlugin: true },
      );
    },
  );

  it(
    "lets a session writer fork their own chat with read, but never exec or a sessionless launch",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => config,
        async (fixture) => {
          const key = await webChatTurn(fixture);
          await expect(
            fixture.client.request("forkproof.run", { sessionKey: key, tools: ["read"] }),
          ).rejects.toThrow(/operator.write/);
          await expect(fixture.ownFork(key, ["read", "exec"])).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });
          fixture.forkScript.calls = [{ name: "read", args: { path: "notes.txt" } }];
          const fork = await fixture.ownFork(key, ["read"]);
          expect(fork, fork.ok ? undefined : fork.message).toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("Release notes.")]);
          expect(fixture.proof.settled.at(-1)).toMatchObject({ ok: true, text: "FORK_DONE" });
        },
        { proxyScopes: ["operator.sessions.write"] },
      );
    },
  );

  it(
    "runs exec through a session-scoped method only on the signed-in caller's own turn",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => ({
          ...config,
          commands: { ownerAllowFrom: ["telegram:7"] },
          tools: {
            ...config.tools,
            exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: false },
          },
        }),
        async (fixture) => {
          const settled = { ok: true, result: { status: "settled" } };
          const exec = (text: string) => [{ name: "exec", args: { command: `echo ${text}` } }];
          const own = await webChatTurn(fixture);
          fixture.forkScript.calls = exec("SAME_PERSON_RAN");
          await expect(fixture.ownFork(own, ["exec"])).resolves.toMatchObject(settled);
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("SAME_PERSON_RAN")]);

          // Another owner's turn: the session-scoped caller may not run exec as that person.
          const other = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-owner-7-${randomUUID()}`,
            "7",
          );
          await expect(fixture.ownFork(other.sessionKey, ["read", "exec"])).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });
          fixture.forkScript.calls = exec("OWNER_TURN_RAN");
          await expect(fixture.fork(other, { tools: ["exec"] })).resolves.toMatchObject(settled);
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("OWNER_TURN_RAN")]);
        },
        { proxyScopes: ["operator.admin", "operator.read", "operator.write"] },
      );
    },
  );
});

/** A WebChat turn by the signed-in client in a chat it creates; returns the session key. */
async function webChatTurn(fixture: Fixture) {
  const { key } = await fixture.client.request<{ key: string }>("sessions.create", {
    agentId: "main",
    label: "Own chat",
  });
  await fixture.client.request("chat.send", {
    sessionKey: key,
    message: "Say hello.",
    idempotencyKey: randomUUID(),
  });
  await expect
    .poll(() => fixture.proof.agentEnds.some((end) => end.sessionKey === key), {
      timeout: 45_000,
    })
    .toBe(true);
  return key;
}
