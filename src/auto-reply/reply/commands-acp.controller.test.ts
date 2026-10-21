import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readDurableAcpSignals,
  withAcpCancellationFixture,
} from "../../acp/control-plane/manager.cancel-session.worker.test-support.js";
import { testing as acpManagerTesting } from "../../acp/control-plane/manager.js";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import type { AcpRuntimeEvent } from "../../plugin-sdk/acp-runtime.js";
import { sessionControllerMailboxes } from "../../sessions/session-controller.mailbox.js";
import { handleAcpCommand } from "./commands-acp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

type Fixture = Parameters<Parameters<typeof withAcpCancellationFixture>[0]>[0];
type CommandFixture = Fixture & { hook: ReturnType<typeof vi.fn> };

async function runAcpCommand(f: Fixture, body: string) {
  const params = buildCommandTestParams(body, f.target.cfg, {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:parent-1",
    AccountId: "default",
    CommandTargetSessionKey: f.target.sessionKey,
  });
  params.command.senderId = "user-1";
  params.command.senderIsOwner = true;
  return await handleAcpCommand(params, true);
}

function startTurn(
  f: Fixture,
  requestId: string,
  onEvent?: (event: AcpRuntimeEvent) => void,
): Promise<void> {
  return f.manager.runTurn({
    ...f.target,
    admittedRunContext: createTestAdmittedRunContext(requestId),
    provenance: "system",
    mode: "prompt",
    text: requestId,
    requestId,
    ...(onEvent ? { onEvent } : {}),
  });
}

async function withCommandFixture(run: (f: CommandFixture) => Promise<void>) {
  await withAcpCancellationFixture(async (f) => {
    acpManagerTesting.setAcpSessionManagerForTests(f.manager);
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    try {
      await run(Object.assign(f, { hook }));
    } finally {
      unregisterInternalHook("command:stop", hook);
      acpManagerTesting.resetAcpSessionManagerForTests();
    }
  });
}

it.each(["running", "idle"] as const)("/acp cancel stops an %s backend", async (phase) => {
  await withCommandFixture(async (f) => {
    const pending: Promise<void>[] = [];
    const queuedEvents: AcpRuntimeEvent[] = [];
    if (phase === "running") {
      const entered = createDeferred();
      f.runTurn.mockImplementationOnce(async function* (input) {
        entered.resolve();
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "done", status: "cancelled" };
      });
      pending.push(
        startTurn(f, "running"),
        startTurn(f, "queued-child-run", (event) => {
          queuedEvents.push(event);
        }),
      );
      await entered.promise;
    }
    try {
      const reply = (await runAcpCommand(f, "/acp cancel"))?.reply?.text;
      expect(reply).toContain(`Cancel requested for ACP session ${f.target.sessionKey}`);
      await Promise.all(pending);
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(f.hook).toHaveBeenCalledOnce();
      if (phase === "running") {
        expect(f.runTurn).toHaveBeenCalledOnce();
        expect(queuedEvents).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
        expect(readDurableAcpSignals(f, "queued-child-run")).toMatchObject([
          { kind: "run_failed", payload_json: expect.stringContaining("cancelled") },
        ]);
      } else {
        expect(f.cancel).toHaveBeenCalledWith(expect.objectContaining({ reason: "manual-cancel" }));
        expect(readAcpSessionEntry(f.target)?.acp?.state).toBe("idle");
      }
    } finally {
      await Promise.allSettled(pending);
    }
  });
});

it("/acp steer waits for the target's running turn, then returns its output", async () => {
  await withCommandFixture(async (f) => {
    const order: string[] = [];
    const entered = createDeferred();
    const release = createDeferred();
    f.runTurn
      .mockImplementationOnce(async function* () {
        entered.resolve();
        await release.promise;
        order.push("running:end");
        yield { type: "done" };
      })
      .mockImplementationOnce(async function* (input) {
        order.push(`${input.mode}:start`);
        yield { type: "text_delta", text: "steered output" };
        yield { type: "done" };
      });
    const running = startTurn(f, "running");
    let steer: ReturnType<typeof runAcpCommand> | undefined;
    try {
      await entered.promise;
      steer = runAcpCommand(f, "/acp steer tighten logging");
      // The steer waits in the target session's mailbox behind the running turn.
      await vi.waitFor(() =>
        expect(
          [...sessionControllerMailboxes()]
            .find((mailbox) => mailbox.owner.aliases.has(f.target.sessionKey))
            ?.entries.map((input) => input.phase),
        ).toEqual(["claimed", "waiting"]),
      );
      release.resolve();
      await running;
      const reply = (await steer)?.reply?.text;
      expect(order).toEqual(["running:end", "steer:start"]);
      expect(reply).toContain("steered output");
    } finally {
      release.resolve();
      await Promise.allSettled([running, steer]);
    }
  });
});
