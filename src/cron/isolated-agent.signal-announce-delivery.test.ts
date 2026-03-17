import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { signalOutbound, telegramOutbound } from "../../test/channel-outbounds.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

/**
 * Regression tests for issue #13915:
 * Confirms that explicit Signal delivery targets survive the full
 * isolated-cron announce pipeline (resolveCronDeliveryPlan →
 * resolveDeliveryTarget → dispatchCronDelivery → deliverOutboundPayloads).
 *
 * All tests pass on current HEAD without production changes, confirming
 * the reported bug (delivery target not passed to Signal send) does not
 * reproduce through this code path. These tests remain as regression
 * guards for the Signal-specific delivery branch in deliverOutboundPayloadsCore,
 * which routes through sendSignalTextChunks → sendSignalText → sendSignal(to, ...)
 * rather than the generic plugin handler sendText.
 */
describe("runCronIsolatedAgentTurn Signal announce delivery (#13915)", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
          source: "test",
        },
        {
          pluginId: "signal",
          plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound }),
          source: "test",
        },
      ]),
    );
  });

  it("routes explicit Signal announce delivery to the correct target", async () => {
    await withTempCronHome(async (home) => {
      // No prior session history — isolated cron with explicit target.
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "signal cron output" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: {
            mode: "announce",
            channel: "signal",
            to: "+15551234567",
          },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(res.deliveryAttempted).toBe(true);
      // The announce flow should route through direct delivery, not the
      // legacy subagent announce path.
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

      // Verify the Signal send function received the correct target.
      expect(deps.sendMessageSignal).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageSignal).toHaveBeenCalledWith(
        "+15551234567",
        "signal cron output",
        expect.any(Object),
      );
    });
  });

  it("routes explicit Signal group target through announce delivery", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "group cron output" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: {
            mode: "announce",
            channel: "signal",
            to: "group:abc123",
          },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(deps.sendMessageSignal).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageSignal).toHaveBeenCalledWith(
        "group:abc123",
        "group cron output",
        expect.any(Object),
      );
    });
  });

  it("preserves Signal target when session has different lastChannel", async () => {
    await withTempCronHome(async (home) => {
      // Session's last channel is telegram, but delivery explicitly targets signal.
      const storePath = await writeSessionStore(home, {
        lastProvider: "telegram",
        lastTo: "999",
        lastChannel: "telegram",
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "cross-channel output" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: {
            mode: "announce",
            channel: "signal",
            to: "+15559876543",
          },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      // Should deliver to Signal, not Telegram.
      expect(deps.sendMessageSignal).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageSignal).toHaveBeenCalledWith(
        "+15559876543",
        "cross-channel output",
        expect.any(Object),
      );
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
    });
  });

  it("uses session lastTo for Signal when channel='last' and session is signal", async () => {
    await withTempCronHome(async (home) => {
      // Session history has signal as last channel with a known target.
      const storePath = await writeSessionStore(home, {
        lastProvider: "signal",
        lastTo: "+15550001111",
        lastChannel: "signal",
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "last-channel output" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: {
            mode: "announce",
            // No explicit channel or to — relies on session history.
          },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(deps.sendMessageSignal).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageSignal).toHaveBeenCalledWith(
        "+15550001111",
        "last-channel output",
        expect.any(Object),
      );
    });
  });

  it("reports delivery-target error when channel='last' with no session history", async () => {
    await withTempCronHome(async (home) => {
      // Empty session store — no last channel to fall back to.
      // This is a separate edge case from #13915: without an explicit
      // channel/to and no session history, delivery-target resolution
      // correctly fails with errorKind="delivery-target".
      const storePath = await writeSessionStore(home, { lastProvider: "", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "output" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: {
            mode: "announce",
            // No channel, no to — and no session history.
          },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      // Without session history or explicit target, delivery should fail
      // with a specific delivery-target error rather than silently dropping.
      expect(res.status).toBe("error");
      expect(res.errorKind).toBe("delivery-target");
      expect(res.error).toContain(
        "Set delivery.channel explicitly or use a main session with a previous channel",
      );
    });
  });

  it("delivers to explicit Signal target even with empty session (isolated cron)", async () => {
    await withTempCronHome(async (home) => {
      // Completely empty session — simulates an isolated cron with no prior
      // conversation. The explicit delivery config should be sufficient.
      const storePath = await writeSessionStore(home, { lastProvider: "", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "isolated output" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: {
            mode: "announce",
            channel: "signal",
            to: "+15557778888",
          },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(deps.sendMessageSignal).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageSignal).toHaveBeenCalledWith(
        "+15557778888",
        "isolated output",
        expect.any(Object),
      );
    });
  });
});
