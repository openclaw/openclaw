import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type MethodResult, withForkGateway } from "./gateway-plugin-forked-turn.test-support.js";

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

          // A non-owner's turn keeps read but not exec.
          const stranger = await fixture.channelTurn(
            `agent:main:telegram:direct:fork-core-7-${randomUUID()}`,
            "7",
          );
          fixture.forkScript.calls = [{ name: "exec", args: { command: "echo STRANGER_RAN" } }];
          await expect(fixture.fork(stranger, coreTools)).resolves.toMatchObject(settled);
          expect(fixture.forkToolOutputs()).toEqual([
            expect.stringContaining("exec is not available in this background run"),
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
          await expect(claim(["write"])).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining('may not add core tool "write"'),
          });
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
});
