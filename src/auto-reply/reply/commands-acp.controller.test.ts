// /acp cancel and /acp steer act on the target session's controller turns.
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

/** Runs one /acp command from a Discord conversation that targets the fixture session. */
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

/** Starts a manager turn the way an agent RPC does, outside any channel dispatch. */
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

async function withCommandFixture(run: (f: Fixture) => Promise<void>) {
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

it("/acp cancel stops the running turn and its queued successor through Stop", async () => {
  await withCommandFixture(async (f) => {
    const hook = (f as Fixture & { hook: ReturnType<typeof vi.fn> }).hook;
    const entered = createDeferred();
    f.runTurn.mockImplementationOnce(async function* (input) {
      entered.resolve();
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", status: "cancelled" };
    });
    const queuedEvents: AcpRuntimeEvent[] = [];
    const running = startTurn(f, "running");
    const queued = startTurn(f, "queued-child-run", (event) => {
      queuedEvents.push(event);
    });
    try {
      await entered.promise;
      const result = await runAcpCommand(f, "/acp cancel");
      expect(result?.reply?.text).toContain(
        `Cancel requested for ACP session ${f.target.sessionKey}`,
      );
      await Promise.all([running, queued]);
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(f.runTurn).toHaveBeenCalledOnce();
      // The queued child never ran, yet its requester still observes a cancelled terminal.
      expect(queuedEvents).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
      expect(readDurableAcpSignals(f, "queued-child-run")).toMatchObject([
        { kind: "run_failed", payload_json: expect.stringContaining("cancelled") },
      ]);
      expect(hook).toHaveBeenCalledOnce();
    } finally {
      await Promise.allSettled([running, queued]);
    }
  });
});

it("/acp cancel sends ACP cancel to an idle backend", async () => {
  await withCommandFixture(async (f) => {
    const hook = (f as Fixture & { hook: ReturnType<typeof vi.fn> }).hook;
    const result = await runAcpCommand(f, "/acp cancel");
    expect(result?.reply?.text).toContain(
      `Cancel requested for ACP session ${f.target.sessionKey}`,
    );
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "manual-cancel" }),
    );
    expect(readAcpSessionEntry(f.target)?.acp?.state).toBe("idle");
    expect(hook).toHaveBeenCalledOnce();
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
      const result = await steer;
      expect(order).toEqual(["running:end", "steer:start"]);
      expect(result?.reply?.text).toContain("steered output");
    } finally {
      release.resolve();
      await Promise.allSettled([running, steer]);
    }
  });
});
