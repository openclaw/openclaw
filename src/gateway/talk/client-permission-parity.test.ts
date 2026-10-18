import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import { createExecTool } from "../../agents/bash-tools.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { projectEffectiveExecPolicy } from "../../agents/session-permission-exec-mode.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { captureSessionMutationRouting } from "../session-sharing-routing.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
  createTalkClientAgentConsultRunner,
  prepareTalkClientControlAuthority,
} from "./client-agent-consult.js";
import { resolveTalkAgentConsultAuthority } from "./client-gateway-control.js";
import { retainTalkClientRunAuthority } from "./client-run-authority.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

const model = vi.hoisted(() => ({ run: vi.fn() }));
// mock-isolation: replace inference while exercising real source guards and native effects.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: model.run }));

// A fixed-action backend replaces inference. Transcript capability, run binding,
// before-tool policy, admission/source guards, and joined OS effects are real.
describe("authenticated Talk permission parity", () => {
  let state: OpenClawTestState;
  let config: OpenClawConfig;
  const sessionKey = "agent:main:permission-parity";
  let sessionTarget: PreparedTalkSessionTarget;
  let voiceSessionId: string;
  const client = sharingPolicyClient({ deviceId: "parity-caller", scopes: ["operator.admin"] });

  function createRunner(
    overrides: Partial<Parameters<typeof createTalkClientAgentConsultRunner>[0]> = {},
  ) {
    return createTalkClientAgentConsultRunner({
      config,
      sessionTarget,
      context: {
        chatAbortControllers: new Map(),
        logGateway: createSubsystemLogger("test/talk-permission-parity"),
      },
      authority: resolveTalkAgentConsultAuthority(client.connect.scopes, client),
      getVoiceSessionId: () => voiceSessionId,
      initialItems: [],
      ...overrides,
    });
  }

  async function retainSource(isCurrent = () => true) {
    const context = {
      getRuntimeConfig: () => config,
      chatAbortControllers: new Map(),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;
    const source = captureGatewayDeviceRevocation(
      context,
      { deviceId: "parity-caller", role: "operator" },
      isCurrent,
      new AbortController().signal,
      { isCurrent: () => true, subscribe: () => () => {}, dependencies: { client, context } },
    );
    const retained = await retainTalkClientRunAuthority({
      client,
      context,
      hasCurrentClientAuthority: source.isCurrent,
    });
    return { context, source, retained };
  }

  function writeSession(fields: Omit<SessionEntry, "sessionId" | "updatedAt">) {
    return replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: sessionTarget.storePath },
      { sessionId: "parity-session", updatedAt: Date.now(), ...fields },
    );
  }

  function execTool(runId: string) {
    return createExecTool({
      ...projectEffectiveExecPolicy({
        base: config.tools!.exec!,
        permissionPolicy: { mode: "full" },
      }),
      config,
      cwd: state.workspaceDir,
      agentId: "main",
      sessionKey,
      runId,
      allowBackground: false,
    });
  }

  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "voice-permission-parity", applyEnv: true });
    config = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
      tools: { exec: { host: "gateway", mode: "full" } },
    };
    await state.writeConfig(config);
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    sessionTarget = {
      agentId: "main",
      sessionKey,
      canonicalKey: sessionKey,
      storePath,
      assertCurrent: captureSessionMutationRouting(config, undefined, [
        { agentId: "main", sessionKey },
      ]),
    };
    await writeSession({
      permissionMode: "full",
      execHost: "gateway",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "discord", to: "old-delivery", accountId: "old-account" },
      }),
    });
    voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
      transcriptCapable: true,
    });
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
  });
  afterAll(async () => {
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    clientVoiceSessionTesting.reset();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it("executes the same permitted native action without an additional voice prompt", async () => {
    const marker = path.join(state.workspaceDir, "effects");
    const action = {
      command: "printf 'effect\n' >> effects",
      workdir: state.workspaceDir,
      yieldMs: 10000,
    };
    const execute = (runId: string) =>
      wrapToolWithBeforeToolCallHook(execTool(runId), {
        agentId: "main",
        sessionKey,
        runId,
        config,
      }).execute("call:" + runId, action);
    const textResult = await execute("text-parity");
    expect(textResult.details).toMatchObject({ status: "completed", exitCode: 0 });
    model.run.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      expect(resolveClientVoiceRunBinding(params.runId)).toMatchObject({ voiceSessionId });
      const result = await execute(params.runId);
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      return { payloads: [{ text: "Done." }], meta: {} };
    });
    const runner = createRunner();
    expect((await runner.runArgs({ question: "Carry out the action." })).text).toBe("Done.");
    expect(await fs.readFile(marker, "utf8")).toBe("effect\neffect\n");
    expect(model.run).toHaveBeenCalledOnce();
  });
  it("uses configured ownership without admin and the session-pinned node/cwd", async () => {
    const ownerClient = sharingPolicyClient({
      user: "configured-owner",
      deviceId: "owner-reviewer",
      scopes: ["operator.read", "operator.write"],
    });
    const cfg: OpenClawConfig = { ...config, commands: { ownerAllowFrom: ["configured-owner"] } };
    const cwd = path.join(state.workspaceDir, "task-worktree");
    await fs.mkdir(cwd, { recursive: true });
    await writeSession({
      permissionMode: "guarded",
      spawnedCwd: cwd,
      sessionRoot: cwd,
      execHost: "node",
      execNode: "session-node",
      execCwd: "/node/task",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "discord", to: "old-target", accountId: "old-account" },
      }),
    });
    model.run.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      expect(params).toMatchObject({
        senderIsOwner: true,
        approvalReviewerDeviceId: "owner-reviewer",
        messageProvider: "webchat",
        workspaceDir: cwd,
        cwd,
        sessionRoot: cwd,
        permissionMode: "guarded",
        execOverrides: { host: "node", node: "session-node", nodeCwd: "/node/task" },
      });
      expect(
        projectEffectiveExecPolicy({
          base: { host: "gateway", mode: "full" },
          overrides: params.execOverrides,
          permissionPolicy: { mode: "guarded" },
        }),
      ).toMatchObject({ host: "node", security: "allowlist", ask: "on-miss" });
      return { payloads: [{ text: "Prepared." }], meta: {} };
    });
    const runner = createRunner({
      config: cfg,
      authority: resolveTalkAgentConsultAuthority(ownerClient.connect.scopes, ownerClient),
    });
    expect(
      await runner.runArgs({
        question: "Do the requested work",
        senderIsOwner: false,
        execHost: "gateway",
        confirmationId: "model-only-yes",
      }),
    ).toEqual({ text: "Prepared." });
  });

  it("fences the native effect when the retained authenticated source is revoked", async () => {
    await writeSession({
      permissionMode: "full",
      execHost: "gateway",
    });
    const { context, source, retained } = await retainSource();
    const marker = path.join(state.workspaceDir, "revoked-effect");
    model.run.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      if (!params.preparedRunAdmission) {
        throw new Error("Missing Talk admission");
      }
      const admittedRunContext = await params.preparedRunAdmission.admit(
        "plugin-harness",
        "parity-native-host",
      );
      const host = createAgentHarnessHostCapabilities({
        pluginId: "parity-native-host",
        attempt: {
          runId: params.runId,
          agentId: "main",
          sessionId: params.sessionId,
          sessionKey,
          workspaceDir: state.workspaceDir,
          admittedRunContext,
        },
      });
      const [tool] = host.capabilities.bindToolSurface([execTool(params.runId)]);
      if (!tool) {
        throw new Error("Missing admitted tool");
      }
      try {
        // Revocation is an owner event, not a model parameter or a mock policy answer.
        invalidateGatewayDeviceRevocation(context, "parity-caller", "operator");
        await expect(
          tool.execute("revoked-call", {
            command: "printf effect > revoked-effect",
            workdir: state.workspaceDir,
          }),
        ).rejects.toThrow(/authority|active/);
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        host.close();
      }
      return { payloads: [{ text: "Denied." }], meta: {} };
    });
    try {
      const runner = createRunner({ context, runAuthority: retained });
      expect(await runner.runArgs({ question: "Carry out the action" })).toEqual({
        text: "Denied.",
      });
    } finally {
      retained.release();
      source.release();
    }
  });
  it("retains but does not accept a pending voice-creation request", async () => {
    let pendingCurrent = true;
    const { source, retained } = await retainSource(() => pendingCurrent);
    try {
      // Provider creation has not committed a logical voice owner yet. A tentative
      // credential change must still fence this request, not only committed revocation.
      pendingCurrent = false;
      expect(source.isCurrent()).toBe(false);
      expect(() => retained.accept()).toThrow("no longer current for admission");
      pendingCurrent = true;
      retained.accept();
      pendingCurrent = false;
      // Once the logical call commits, accepted work retains committed source
      // custody independently of a later retired request or audio transport.
      expect(source.isCurrent()).toBe(true);
    } finally {
      retained.release();
      source.release();
    }
  });
  it("does not manufacture reply authority when the authenticated caller is missing", () => {
    expect(() =>
      prepareTalkClientControlAuthority({
        config,
        sessionTarget,
        source: "reply",
        authority: { senderIsOwner: false },
        agentRuntime: createPluginRuntime().agent,
      }),
    ).toThrow("Talk chat caller authority is unavailable");
  });
});
