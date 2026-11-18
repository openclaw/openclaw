// Load the Gateway and model runtime outside the test's authority deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { requireGit } from "../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry-replace.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import * as restartResume from "./session-restart-resume.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "finishes a marked restart exactly once after its pending workspace is prepared",
  { timeout: 90_000 },
  async ({ signal }) => {
    const state = await createProductState("restart-workspace");
    const sessionKey = "agent:main:dashboard:restart-workspace";
    const target = { agentId: "main", sessionKey };
    const checkoutEntered = createDeferred();
    const releaseCheckout = createDeferred();
    const recoveryEntered = createDeferred<{
      params: Parameters<typeof restartResume.resumeMarkedSessions>[0];
      work: Promise<void>;
    }>();
    const receipts: ReturnType<typeof sessionEvents.enqueueSessionEventForHost>[] = [];
    const providerInputs: string[] = [];
    const providerErrors: unknown[] = [];
    const provider = productProvider(providerErrors, (body, response) => {
      providerInputs.push(body);
      writeOpenAiResponsesText(response, {
        text: "RESUMED_AFTER_WORKSPACE_READY",
        messageId: "msg_workspace_resume",
        responseId: "resp_workspace_resume",
      });
    });
    const resume = restartResume.resumeMarkedSessions;
    const recoveryObserver = vi
      .spyOn(restartResume, "resumeMarkedSessions")
      .mockImplementation((params) => {
        const work = resume(params);
        recoveryEntered.resolve({ params, work });
        return work;
      });
    const enqueue = sessionEvents.enqueueSessionEventForHost;
    const eventObserver = vi
      .spyOn(sessionEvents, "enqueueSessionEventForHost")
      .mockImplementation((...args) => {
        const receipt = enqueue(...args);
        receipts.push(receipt);
        return receipt;
      });
    // Hold the real checkout at its I/O boundary, without manufacturing readiness or admission.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const create = ManagedWorktreeService.prototype.createWithOutcome;
    const checkoutObserver = vi
      .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
      .mockImplementation(async function (this: ManagedWorktreeService, params) {
        if (params.ownerId === sessionKey) {
          checkoutEntered.resolve();
          await releaseCheckout.promise;
        }
        return create.call(this, params);
      });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await requireGit(state.workspaceDir, ["init", "-b", "main"]);
      await requireGit(state.workspaceDir, ["config", "user.name", "OpenClaw Test"]);
      await requireGit(state.workspaceDir, ["config", "user.email", "test@example.invalid"]);
      await fs.writeFile(path.join(state.workspaceDir, "marker.txt"), "prepared workspace\n");
      await requireGit(state.workspaceDir, ["add", "."]);
      await requireGit(state.workspaceDir, ["commit", "-qm", "synthetic workspace"]);
      const model = productModelConfig(
        state.workspaceDir,
        buildMockOpenAiResponsesProvider(await listenProvider(provider), "restart-workspace"),
      );
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: { ...model.defaults, utilityModel: "" },
        },
        models: model.models,
        plugins: { slots: { memory: "none" } },
        tools: { profile: "minimal", codeMode: false, toolSearch: false },
        worktreeAcceleration: false,
        gateway: { auth: { mode: "token", token: "restart-workspace-proof" } },
      };
      await state.writeConfig(cfg);
      const entry = { sessionId: "restart-workspace", updatedAt: Date.now() };
      replaceSessionEntrySync(target, entry);
      replaceSessionEntrySync(target, {
        ...entry,
        resumeAfterRestart: { queuedInputIds: [] },
        pendingWorktree: {
          workspace: state.workspaceDir,
          name: "restart-workspace",
          titleSource: "",
        },
      });
      expect((await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart).toBeDefined();
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: "restart-workspace-proof",
      });
      const recovery = await withinTest(recoveryEntered.promise, signal);
      const admitted = recovery.work.then(async () => {
        expect(await Promise.all(receipts.map((receipt) => receipt.accepted))).toEqual([
          { ok: true },
        ]);
      });
      await withinTest(
        awaitGateBeforeSettlement(
          checkoutEntered.promise,
          admitted,
          "Restart recovery terminated before preparing its pending workspace",
        ),
        signal,
      );
      expect(providerInputs).toEqual([]);
      const preparing = await readSessionEntryReadOnlyInWorker(target);
      expect(preparing?.pendingWorktree).toBeDefined();
      expect(preparing?.resumeAfterRestart).toBeDefined();
      releaseCheckout.resolve();
      await withinTest(admitted, signal);
      await expect(withinTest(receipts[0]!.settled, signal)).resolves.toMatchObject({
        status: "completed",
        executionStarted: true,
      });
      await resume(recovery.params);
      expect(receipts).toHaveLength(1);
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]).toContain("The Gateway restarted while you were working.");
      const saved = await readSessionEntryReadOnlyInWorker(target);
      expect(saved?.pendingWorktree).toBeUndefined();
      expect(saved?.resumeAfterRestart).toBeUndefined();
      expect(await fs.readFile(path.join(saved!.spawnedCwd!, "marker.txt"), "utf8")).toBe(
        "prepared workspace\n",
      );
      const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey,
      });
      expect(JSON.stringify(history.messages)).toContain("RESUMED_AFTER_WORKSPACE_READY");
      expect(providerErrors).toEqual([]);
    } finally {
      releaseCheckout.resolve();
      await closeProvider(provider);
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "restart workspace proof complete" });
      }
      checkoutObserver.mockRestore();
      eventObserver.mockRestore();
      recoveryObserver.mockRestore();
      await state.cleanup();
    }
  },
);
