import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../config/config.js";
import { readSessionEntrySummariesInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { CronService } from "../../cron/service.js";
import { readAgentDeletionJournalAsync } from "../../state/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { withAgentTerminalOpenAdmission } from "../terminal/open-admission.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import {
  baseOpenRequest,
  expectTerminalOpen,
  makeFakePty,
} from "../terminal/session-manager.test-helpers.js";
import { deleteGatewayAgent } from "./agents-delete.js";

async function openTerminal(
  terminals: TerminalSessionManager,
  pty: ReturnType<typeof makeFakePty>,
  options: Parameters<typeof baseOpenRequest>[0],
) {
  return expectTerminalOpen(
    await terminals.open(baseOpenRequest({ ...options, createBackend: async () => pty })),
  );
}

it("keeps deletion draining until every connection terminal exits, without touching a survivor", () =>
  withOpenClawTestState({ label: "agent-delete-terminals" }, async (state) => {
    const workspace = state.path("workspace-doomed");
    const witness = "still owned by terminal work";
    await fs.mkdir(workspace);
    await fs.writeFile(`${workspace}/witness.txt`, witness);
    await state.writeConfig({
      agents: {
        ownership: "explicit",
        defaults: { skipBootstrap: true },
        entries: {
          keeper: { workspace: state.workspaceDir },
          doomed: { workspace },
        },
      },
    });
    expect(
      await readSessionEntrySummariesInWorker({
        agentId: "doomed",
        storePath: `${state.sessionsDir("doomed")}/sessions.json`,
      }),
    ).toEqual([]);
    const scheduler = createTestGatewayScheduler();
    const cron = new CronService({
      scheduler,
      storePath: state.statePath("cron/jobs.json"),
      cronEnabled: false,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const terminals = new TerminalSessionManager({
      emit: () => {},
      withOpenAdmission: withAgentTerminalOpenAdmission,
      detachGraceMs: 60_000,
    });
    const context = createDirectChatContext({
      cron,
      getRuntimeConfig,
      terminalSessions: terminals,
    });
    const ptys = [makeFakePty(), makeFakePty(), makeFakePty()];
    const pendingPty = makeFakePty();
    const backend = createDeferred<typeof pendingPty>();
    const request = baseOpenRequest({ agentId: "doomed", createBackend: () => backend.promise });
    const opening = terminals.open(request);
    const keeper = makeFakePty();
    const killed = createDeferred();
    const kill = ptys[0]!.kill.bind(ptys[0]);
    ptys[0]!.kill = () => {
      kill();
      killed.resolve();
    };
    let deleting: ReturnType<typeof deleteGatewayAgent> | undefined;
    try {
      for (const [index, pty] of ptys.entries()) {
        const opened = await openTerminal(terminals, pty, {
          agentId: "doomed",
          owner: { kind: "conn", connId: `doomed-${index}` },
          cwd: workspace,
        });
        if (index === 1) {
          terminals.handleDisconnect("doomed-1");
        } else if (index === 2) {
          expect(terminals.close("doomed-2", opened.sessionId)).toBe(true);
        }
      }
      const survivor = await openTerminal(terminals, keeper, {
        agentId: "keeper",
        owner: { kind: "conn", connId: "keeper" },
      });
      deleting = deleteGatewayAgent("doomed", true, context);
      const settled = vi.fn();
      void deleting.then(settled, settled);
      await awaitGateBeforeSettlement(
        killed.promise,
        deleting,
        "deletion skipped connection terminals",
      );
      backend.resolve(pendingPty);
      await expect(opening).resolves.toMatchObject({ ok: false, code: "closed" });
      expect(pendingPty.killed).toBe(true);
      await expect(terminals.open(baseOpenRequest({ agentId: "doomed" }))).resolves.toMatchObject({
        ok: false,
        code: "closed",
      });
      expect(ptys[1]!.killed).toBe(true);
      expect(keeper.killed).toBe(false);
      for (const index of [0, 1]) {
        ptys[index]!.emitExit(0);
      }
      expect(settled).not.toHaveBeenCalled();
      expect(await fs.readFile(`${workspace}/witness.txt`, "utf8")).toBe(witness);
      expect(terminals.write("keeper", survivor.sessionId, "still usable")).toBe(true);
      ptys[2]!.emitExit(0);
      expect(await readAgentDeletionJournalAsync("doomed")).toMatchObject({
        phase: "draining",
        cleanupCompleted: false,
      });
      expect(settled).not.toHaveBeenCalled();
      pendingPty.emitExit(0);
      await expect(deleting).resolves.toMatchObject({ ok: true, failed: [] });
      expect(await readAgentDeletionJournalAsync("doomed")).toMatchObject({
        cleanupCompleted: true,
      });
      await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(keeper.killed).toBe(false);
      expect(terminals.write("keeper", survivor.sessionId, "survived deletion")).toBe(true);
    } finally {
      backend.resolve(pendingPty);
      await opening;
      pendingPty.emitExit(0);
      for (const pty of ptys) {
        pty.emitExit(0);
      }
      await Promise.allSettled([deleting]);
      terminals.disposeAll();
      keeper.emitExit(0);
      vi.useRealTimers();
      cron.stop();
      await cron.waitForIdle();
      await scheduler.stop();
    }
  }));
