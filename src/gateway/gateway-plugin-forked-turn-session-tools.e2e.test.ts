import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  type Fixture,
  type MethodResult,
  withForkGateway,
} from "./gateway-plugin-forked-turn.test-support.js";

const EXEC_FULL = { host: "gateway", security: "full", ask: "off", notifyOnExit: false } as const;

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
            exec: EXEC_FULL,
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

          // exec follows the caller, not the anchored turn's sender: the admin runs it on a
          // stranger's turn, as the admin's own next turn in that chat could.
          const stranger = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-core-7-${randomUUID()}`,
            "7",
          );
          fixture.forkScript.calls = [
            { name: "read", args: { path: "notes.txt" } },
            { name: "exec", args: { command: "echo STRANGER_TURN_RAN" } },
          ];
          await expect(fixture.fork(stranger, coreTools)).resolves.toMatchObject(settled);
          expect(fixture.forkToolOutputs()).toEqual([
            expect.stringContaining("Release notes."),
            expect.stringContaining("STRANGER_TURN_RAN"),
          ]);

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

          // An internal wake as the latest input changes nothing for a caller without exec.
          await appendWake(key, fixture.workspaceDir, {
            kind: "inter_session",
            sourceTool: "subagent_announce",
          });
          await expect(fixture.ownFork(key, ["read", "ls", "exec"])).resolves.toEqual({
            ok: true,
            result: { status: "refused", reason: "tool_policy" },
          });
          fixture.forkScript.calls = [{ name: "ls", args: { path: "." } }];
          await expect(fixture.ownFork(key, ["read", "ls"])).resolves.toMatchObject({
            ok: true,
            result: { status: "settled" },
          });
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("notes.txt")]);
        },
        { proxyScopes: ["operator.sessions.write"] },
      );
    },
  );

  it(
    "runs exec on the caller's admitted authority when the latest input is an internal wake",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => ({ ...config, tools: { ...config.tools, exec: EXEC_FULL } }),
        async (fixture) => {
          const settled = { ok: true, result: { status: "settled" } };
          const tools = ["read", "ls", "exec"];
          for (const [name, provenance] of [
            ["SUBAGENT", { kind: "inter_session", sourceTool: "subagent_announce" }],
            ["EXEC", { kind: "internal_system", sourceTool: "exec" }],
          ] as const) {
            const owner = await fixture.dashboardTurn(
              `agent:main:dashboard:direct:fork-wake-${randomUUID()}`,
            );
            await appendWake(owner.sessionKey, fixture.workspaceDir, provenance);
            // Without `through`, the fork reads through the wake's answer, as `/better` does.
            fixture.forkScript.calls = [{ name: "exec", args: { command: `echo ${name}_WAKE` } }];
            await expect(fixture.fork(owner, { tools, through: undefined })).resolves.toMatchObject(
              settled,
            );
            expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining(`${name}_WAKE`)]);
            fixture.forkScript.calls = [{ name: "exec", args: { command: `echo OWN_${name}` } }];
            await expect(fixture.ownFork(owner.sessionKey, tools)).resolves.toMatchObject(settled);
            expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining(`OWN_${name}`)]);
          }
        },
      );
    },
  );

  it(
    "runs exec for an admin caller through a session-scoped method on any owner's turn",
    { timeout: 150_000 },
    async () => {
      await withForkGateway(
        (config) => ({
          ...config,
          commands: { ownerAllowFrom: ["telegram:7"] },
          tools: {
            ...config.tools,
            exec: EXEC_FULL,
          },
        }),
        async (fixture) => {
          const settled = { ok: true, result: { status: "settled" } };
          const exec = (text: string) => [{ name: "exec", args: { command: `echo ${text}` } }];
          const own = await webChatTurn(fixture);
          fixture.forkScript.calls = exec("SAME_PERSON_RAN");
          await expect(fixture.ownFork(own, ["exec"])).resolves.toMatchObject(settled);
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("SAME_PERSON_RAN")]);

          // Another owner's turn: the session-scoped method admits the same exec the admin
          // already runs there through a plain operator method.
          const other = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-owner-7-${randomUUID()}`,
            "7",
          );
          fixture.forkScript.calls = exec("SESSION_METHOD_RAN");
          await expect(fixture.ownFork(other.sessionKey, ["read", "exec"])).resolves.toMatchObject(
            settled,
          );
          expect(fixture.forkToolOutputs()).toEqual([
            expect.stringContaining("SESSION_METHOD_RAN"),
          ]);
          fixture.forkScript.calls = exec("OWNER_TURN_RAN");
          await expect(fixture.fork(other, { tools: ["exec"] })).resolves.toMatchObject(settled);
          expect(fixture.forkToolOutputs()).toEqual([expect.stringContaining("OWNER_TURN_RAN")]);
        },
        { proxyScopes: ["operator.admin", "operator.read", "operator.write"] },
      );
    },
  );
});

/**
 * Appends a stored internal wake (a subagent or exec completion) and its answer, as the host
 * records them: never owner-attributed, whoever started the work.
 */
async function appendWake(
  sessionKey: string,
  workspaceDir: string,
  provenance: { kind: "inter_session" | "internal_system"; sourceTool: string },
) {
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  const sessionId = expectDefined(loadSessionEntry(scope)?.sessionId, "session id");
  const session = await SessionManager.openAsync({ ...scope, sessionId }, workspaceDir);
  const timestamp = Date.now();
  const messages = [
    {
      role: "user",
      content: "Continue the OpenClaw runtime event.",
      timestamp,
      provenance,
      __openclaw: {
        senderIsOwner: false,
        requesterOrigin: { messageProvider: "webchat", operatorProfileId: "owner-profile" },
      },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Handled the event." }],
      api: "openai-responses",
      provider: "mock-openai",
      model: "fork-proof",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: timestamp + 1,
    },
  ];
  for (const message of messages) {
    // SAFETY: fixtures follow the stored message shapes the transcript owner accepts.
    await session.appendMessageAsync(message as never);
  }
}

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
