import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RuntimeConfigWriteApplicationStatus } from "../../config/runtime-write-application.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../../process/gateway-work-admission.test-helpers.js";
import {
  agentConfig,
  expectRecordFields,
  expectRespondErrorContaining,
  expectRespondOk,
  getAgentList,
  mockCallArg,
} from "./agents-mutate.test-support.js";
import type { GatewayRequestHandlers } from "./types.js";

type AgentCreateMocks = {
  loadConfigReturn: Record<string, unknown>;
  captureDeletedAgentDatabaseFences: Mock<() => [string, string][]>;
  reviveAgentDatabases: Mock<(agentIds: readonly string[]) => Promise<void>>;
  captureGatewayOperatorRunAuthority: Mock;
  configApplicationStatus: Mock<() => RuntimeConfigWriteApplicationStatus>;
  prepareAgentOnboarding: Mock;
  completeAgentOnboarding: Mock;
  startAgentOnboardingConversation: Mock;
  writeConfigFile: Mock<(nextConfig?: unknown, writeOptions?: unknown) => Promise<void>>;
  ensureAgentWorkspace: Mock<
    (params?: { dir?: string }) => Promise<{ dir: string; identityPathCreated: boolean }>
  >;
  resolveAgentWorkspaceDir: Mock<(config?: unknown, agentId?: string) => string>;
  applyAgentConfig: Mock<(config: unknown, options: unknown) => object>;
  rootWrite: Mock<(params?: unknown) => Promise<void>>;
  logGatewayWarn: Mock;
};

type AgentCreateHarness = {
  mocks: AgentCreateMocks;
  call: (method: "agents.create", params: Record<string, unknown>) => Promise<Mock>;
  createContext: () => unknown;
  agentsHandlers: GatewayRequestHandlers;
};

export function registerAgentCreateTests({
  mocks,
  call,
  createContext,
  agentsHandlers,
}: AgentCreateHarness): void {
  describe("agents.create", () => {
    beforeEach(() => {
      mocks.captureDeletedAgentDatabaseFences.mockReturnValue([]);
      mocks.reviveAgentDatabases.mockReset().mockResolvedValue(undefined);
      mocks.captureGatewayOperatorRunAuthority.mockReset();
      mocks.loadConfigReturn = agentConfig({ main: {} });
    });

    const create = (params: Record<string, unknown>) => call("agents.create", params);
    it.each(["failed", "restart-pending", "unclaimed"] as const)(
      "retains the committed agent when onboarding config application is %s",
      async (status) => {
        mocks.loadConfigReturn.session = { mainKey: "home" };
        mocks.configApplicationStatus.mockReturnValue(status);
        mocks.prepareAgentOnboarding.mockResolvedValueOnce({
          expectedConfigHash: "test-hash",
          assertCurrent: vi.fn(),
        });

        const respond = await create({
          agentId: "bot-stable",
          name: "New agent",
          onboarding: true,
        });

        expectRespondOk(respond, {
          ok: true,
          agentId: "bot-stable",
          name: "New agent",
          workspace: "/resolved/workspace/bot-stable",
          agentDir: "/agents/test-agent",
          onboarding: {
            status: "error",
            sessionKey: "agent:bot-stable:home",
            error: expect.stringContaining(`not confirmed (${status})`),
          },
        });
        expect(respond).toHaveBeenCalledOnce();
        expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
        expect(mocks.loadConfigReturn).toMatchObject({
          agents: { entries: { "bot-stable": { name: "New agent" } } },
        });
        expect(mocks.completeAgentOnboarding).not.toHaveBeenCalled();
      },
    );
    it("retains the existing unconfirmed-application error for creation without onboarding", async () => {
      mocks.configApplicationStatus.mockReturnValue("failed");
      expectRespondErrorContaining(await create({ name: "Test Agent" }), "not confirmed (failed)");
      expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
      expect(mocks.completeAgentOnboarding).not.toHaveBeenCalled();
    });
    it.each(["completed", "error"] as const)(
      "returns the created agent even when onboarding is $status",
      async (status) => {
        const onboarding =
          status === "completed"
            ? { status, sessionKey: "agent:test-agent:home" }
            : { status, sessionKey: "agent:test-agent:home", error: "inference unavailable" };
        mocks.prepareAgentOnboarding.mockImplementation(async () => {
          expect(mocks.writeConfigFile).not.toHaveBeenCalled();
          return { expectedConfigHash: "test-hash", assertCurrent: vi.fn() };
        });
        mocks.completeAgentOnboarding.mockImplementation(async (_options, agentId) => {
          expect(agentId).toBe("test-agent");
          expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
          return onboarding;
        });
        expectRespondOk(await create({ name: "Test Agent", onboarding: true }), {
          ok: true,
          agentId: "test-agent",
          onboarding,
        });
        expect(mocks.completeAgentOnboarding).toHaveBeenCalledOnce();
      },
    );
    it("retains the create request's Gateway work while onboarding starts after its receipt", async () => {
      const { promise: started, resolve: onboardingStarted } = createDeferred();
      const { promise: onboarding, resolve: releaseOnboarding } = createDeferred();
      mocks.prepareAgentOnboarding.mockResolvedValueOnce({
        expectedConfigHash: "test-hash",
        assertCurrent: vi.fn(),
      });
      mocks.completeAgentOnboarding.mockResolvedValueOnce({
        status: "completed",
        sessionKey: "agent:bot-stable:home",
      });
      mocks.startAgentOnboardingConversation.mockImplementationOnce(async () => {
        onboardingStarted();
        await onboarding;
      });

      await runWithGatewayRootWorkAdmissionForTest(async () => {
        expectRespondOk(
          await create({ agentId: "bot-stable", name: "Preview Agent", onboarding: true }),
          {
            ok: true,
            agentId: "bot-stable",
            name: "Preview Agent",
            workspace: "/resolved/workspace/bot-stable",
            agentDir: "/agents/test-agent",
            onboarding: { status: "completed", sessionKey: "agent:bot-stable:home" },
          },
        );
      });

      await started;
      expect(mocks.startAgentOnboardingConversation).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      releaseOnboarding();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    });
    it("captures operator authority before the create receipt and carries it into onboarding", async () => {
      const operatorAuthority = { assertCurrent: vi.fn(), retain: vi.fn(() => vi.fn()) };
      const releaseAuthority = vi.fn();
      const { promise: onboarding, resolve: releaseOnboarding } = createDeferred();
      const { promise: started, resolve: onboardingStarted } = createDeferred<unknown>();
      const client = {
        connect: { role: "operator", scopes: ["operator.admin"], client: { id: "control-ui" } },
        internal: { authenticatedOperator: true },
      };
      const hasCurrentClientAuthority = vi.fn(() => true);
      mocks.prepareAgentOnboarding.mockResolvedValueOnce({
        expectedConfigHash: "test-hash",
        assertCurrent: vi.fn(),
      });
      mocks.completeAgentOnboarding.mockResolvedValueOnce({
        status: "completed",
        sessionKey: "agent:bot-stable:home",
      });
      mocks.captureGatewayOperatorRunAuthority.mockImplementationOnce(async () => {
        expect(hasCurrentClientAuthority()).toBe(true);
        return { authority: operatorAuthority, release: releaseAuthority };
      });
      mocks.startAgentOnboardingConversation.mockImplementationOnce(async (options: unknown) => {
        onboardingStarted(options);
        await onboarding;
      });

      let response!: ReturnType<typeof vi.fn<(ok: boolean) => void>>;
      await runWithGatewayRootWorkAdmissionForTest(async () => {
        response = vi.fn((_ok: boolean) => {
          expect(mocks.captureGatewayOperatorRunAuthority).toHaveBeenCalledOnce();
        });
        const handler = expectDefined(agentsHandlers["agents.create"], "agents.create handler");
        await handler({
          params: { agentId: "bot-stable", name: "Preview Agent", onboarding: true },
          respond: response,
          context: createContext() as never,
          req: { type: "req", id: "authority-test", method: "agents.create" },
          client: client as never,
          hasCurrentClientAuthority,
          isWebchatConnect: () => false,
        });
      });

      expectRespondOk(response, {
        ok: true,
        agentId: "bot-stable",
        name: "Preview Agent",
        workspace: "/resolved/workspace/bot-stable",
        agentDir: "/agents/test-agent",
        onboarding: { status: "completed", sessionKey: "agent:bot-stable:home" },
      });
      const receivedOptions = await started;
      expect(receivedOptions).toMatchObject({
        client: { internal: { operatorRunAuthority: operatorAuthority } },
      });
      expect(releaseAuthority).not.toHaveBeenCalled();
      releaseOnboarding();
      await vi.waitFor(() => expect(releaseAuthority).toHaveBeenCalledOnce());
    });
    it("does not create an agent or workspace when inference verification fails", async () => {
      mocks.prepareAgentOnboarding.mockRejectedValueOnce(new Error("Inference unavailable"));
      expectRespondErrorContaining(
        await create({ agentId: "bot-unavailable", name: "New agent", onboarding: true }),
        "Inference unavailable",
      );
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
      expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
      expect(mocks.completeAgentOnboarding).not.toHaveBeenCalled();
    });
    it.each([
      { name: "Test Agent", workspace: "/home/user/agents/test", fancy: false },
      { name: "Test Agent", workspace: undefined, fancy: false },
      { name: "Fancy Agent", workspace: "/tmp/ws", fancy: true },
    ])("creates $name (workspace=$workspace)", async ({ name, workspace, fancy }) => {
      const respond = await create({
        name,
        ...(workspace ? { workspace } : {}),
        ...(fancy
          ? { model: "sonnet-4.6", emoji: "🤖", avatar: "https://example.com/avatar.png" }
          : {}),
      });
      expectRespondOk(respond, {
        ok: true,
        agentId: fancy ? "fancy-agent" : "test-agent",
        name,
        ...(fancy ? { model: "sonnet-4.6" } : {}),
      });
      expect(mocks.ensureAgentWorkspace).toHaveBeenCalled();
      expect(mocks.writeConfigFile).toHaveBeenCalled();
      expect(mocks.reviveAgentDatabases).not.toHaveBeenCalled();
      expect(mocks.completeAgentOnboarding).not.toHaveBeenCalled();
      if (!workspace) {
        expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(
          expect.any(Object),
          "test-agent",
        );
        expectRespondOk(respond, { workspace: "/resolved/workspace/test-agent" });
      }
      if (fancy) {
        expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {
          model: "sonnet-4.6",
          identity: expect.objectContaining({
            name: "Fancy Agent",
            emoji: "🤖",
            avatar: "https://example.com/avatar.png",
          }),
        });
        expectRecordFields(mockCallArg(mocks.rootWrite), {
          rootDir: "/resolved/tmp/ws",
          relativePath: "IDENTITY.md",
          data: "# IDENTITY.md - Agent Identity\n\n- Name: Fancy Agent\n- Emoji: 🤖\n- Avatar: https://example.com/avatar.png\n",
        });
      }
    });
    it("persists a display name independently of the stable internal agent id", async () => {
      const agentId = "bot-00000000-0000-4000-8000-000000000001";
      const respond = await create({ agentId, name: "New Bot", emoji: "🤖" });

      expectRespondOk(respond, { ok: true, agentId, name: "New Bot" });
      expect(mocks.loadConfigReturn).toMatchObject({
        agents: {
          entries: {
            [agentId]: { name: "New Bot", identity: { name: "New Bot", emoji: "🤖" } },
          },
        },
      });
      expect(getAgentList(mocks.loadConfigReturn).map((agent) => agent.id)).toEqual([
        "main",
        agentId,
      ]);
      expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
    });

    it("reports committed creation when deleted database reader revival fails", async () => {
      mocks.captureDeletedAgentDatabaseFences.mockReturnValue([
        ["/agents/test-agent/openclaw-agent.sqlite", "test-agent"],
      ]);
      mocks.reviveAgentDatabases.mockRejectedValueOnce(new Error("worker acknowledgement failed"));
      const respond = await create({ name: "Test Agent" });

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      expect(mocks.loadConfigReturn).toMatchObject({
        agents: { entries: { "test-agent": { name: "Test Agent" } } },
      });
      expect(mocks.writeConfigFile).toHaveBeenCalledExactlyOnceWith(mocks.loadConfigReturn);
      expect(mocks.reviveAgentDatabases).toHaveBeenCalledExactlyOnceWith(["test-agent"]);
      expect(mocks.logGatewayWarn).toHaveBeenCalledExactlyOnceWith(
        "agent config committed; worker reader revival will reconcile at next task: worker acknowledgement failed",
      );
    });

    it("rejects invalid params (missing name)", async () => {
      const respond = await create({ workspace: "/tmp/ws" });
      expectRespondErrorContaining(respond, "invalid");
    });
  });
}
