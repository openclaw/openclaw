import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
} from "../../components/terminal/terminal-panel.test-support.ts";
import {
  createDraftFixture,
  registerTextPayload,
  resetSubmissionMocks,
  stubObjectUrls,
} from "./draft-submission-flow.test-support.ts";
import { loadNewSessionPreference, replaceBrowserPreference } from "./preferences.ts";

afterEach(resetSubmissionMocks);

const nativeTerminalController = vi.fn(async () => createTerminalController());
const nativeTerminalElement = defineTestTerminalPanelElement(nativeTerminalController);

function mountNativeTerminal(context: ApplicationContext) {
  const listeners = new Set<(event: { event: string; payload: unknown }) => void>();
  const client = expectDefined(context.gateway.snapshot.client, "connected Gateway");
  Object.assign(client, {
    addEventListener: (listener: (event: { event: string; payload: unknown }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forceReconnect: vi.fn(),
  });
  const panel = createTestTerminalPanel(nativeTerminalElement);
  panel.client = client;
  panel.available = true;
  panel.page = true;
  panel.fullscreen = true;
  panel.embedded = true;
  Object.assign(context, {
    replace: vi.fn((routeId, options) => {
      if (routeId === "terminal") {
        panel.routeTarget = { sessionId: options.pathname.split("/").at(-1) };
        document.body.append(panel);
      }
    }),
  });
  return {
    panel,
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners) {
        listener({ event, payload });
      }
    },
  };
}

const nativeData = {
  agentId: "main",
  requestedAgentId: "main",
  catalogId: "codex",
  catalogLabel: "Codex",
  startTerminal: true,
  terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
};

function createNativeFixture(options: Parameters<typeof createDraftFixture>[0] = {}) {
  return createDraftFixture({
    scopes: ["operator.admin"],
    methods: ["sessions.catalog.startTerminal", "terminal.open"],
    data: nativeData,
    ...options,
  });
}

function startCalls(request: ReturnType<typeof createDraftFixture>["request"]) {
  return request.mock.calls.filter(([method]) => method === "sessions.catalog.startTerminal");
}
const waitForStart = (request: ReturnType<typeof createDraftFixture>["request"]) =>
  vi.waitFor(() => expect(startCalls(request)).toHaveLength(1));

function expectNativeStart(
  request: ReturnType<typeof createDraftFixture>["request"],
  params: { catalogId?: string; cwd?: string; hostId?: string; initialMessage?: string },
) {
  expect(request).toHaveBeenCalledWith(
    "sessions.catalog.startTerminal",
    { agentId: "main", catalogId: "codex", hostId: "gateway:local", cwd: "/workspace", ...params },
    { timeoutMs: 35_000 },
  );
}

describe("DraftSubmissionFlow native terminal", () => {
  it.each([
    { catalogId: "codex", exitCode: 0, signal: 1, exitLabel: "exited (signal 1)" },
    { catalogId: "claude", exitCode: 1, signal: 0, exitLabel: "exited (1)" },
  ])(
    "primary submission retains $catalogId output and exit that precede the native start response",
    async ({ catalogId, exitCode, signal, exitLabel }) => {
      const controller = createTerminalController();
      const outputWritten = createDeferred();
      controller.write.mockImplementation(() => outputWritten.resolve());
      nativeTerminalController.mockResolvedValueOnce(controller);
      const { context, flow, request } = createNativeFixture({
        scopes: ["operator.admin", "operator.read", "operator.write"],
        methods: ["sessions.create", "sessions.catalog.startTerminal", "terminal.open"],
        data: {
          ...nativeData,
          catalogId,
          catalogLabel: catalogId,
          terminalHosts: [{ hostId: "gateway:local", label: "Local CLI" }],
        },
        request: async (method) => {
          if (method === "sessions.catalog.startTerminal") {
            terminal.emit("terminal.data", {
              sessionId: "terminal-created",
              seq: 23,
              data: "Native CLI startup text",
            });
            terminal.emit("terminal.exit", {
              sessionId: "terminal-created",
              reason: "process_exit",
              exitCode,
              signal,
            });
            return terminalOpenResult("terminal-created");
          }
          if (method === "terminal.attach") {
            throw new Error('unknown terminal session "terminal-created"');
          }
          return {};
        },
      });
      const terminal = mountNativeTerminal(context);
      flow.setMessage("start this task");
      await flow.submit();

      await outputWritten.promise;
      expect(controller.write).toHaveBeenCalledWith(
        new TextEncoder().encode("Native CLI startup text"),
      );
      expectNativeStart(request, { catalogId, initialMessage: "start this task" });
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(flow.message).toBe("");
      await terminal.panel.updateComplete;
      expect(terminal.panel.textContent).toContain(exitLabel);
      expect(terminal.panel.textContent).not.toContain("Could not attach");
      expect(request.mock.calls.some(([method]) => method === "terminal.attach")).toBe(false);
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBeNull();
      expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull();
    },
  );

  it.each(["accepted", "rejected", "cancelled"] as const)(
    "keeps a native start pending until %s",
    async (outcome) => {
      const starting = createDeferred<ReturnType<typeof terminalOpenResult>>();
      const { context, flow, request } = createNativeFixture({
        data:
          outcome === "accepted"
            ? { ...nativeData, catalogId: "synthetic-cli", catalogLabel: "Synthetic CLI" }
            : nativeData,
        request: async (method) =>
          method === "sessions.catalog.startTerminal" ? starting.promise : {},
      });
      const { panel } = mountNativeTerminal(context);
      const message = outcome === "accepted" ? "" : "keep my prompt";
      flow.setMessage(message);
      const submitting = flow.submit();
      await waitForStart(request);
      expect(flow).toMatchObject({ message, submitting: true });
      const duplicate = outcome === "accepted" ? flow.submit() : undefined;
      if (outcome === "rejected") {
        starting.reject(new Error("Native CLI is unavailable"));
      } else {
        if (outcome === "cancelled") {
          flow.invalidate("gateway-changed");
        }
        starting.resolve(terminalOpenResult("native-start"));
      }
      await Promise.all([submitting, duplicate]);
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      if (outcome === "accepted") {
        expect(startCalls(request)).toHaveLength(1);
        expect(context.replace).toHaveBeenCalledOnce();
        expect(flow.submitting).toBe(false);
      } else {
        expect(flow.message).toBe(message);
        expect(context.replace).not.toHaveBeenCalled();
        if (outcome === "cancelled") {
          expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: "native-start" });
        } else {
          expect(flow.error).toContain("Native CLI is unavailable");
          expect(panel.isConnected).toBe(false);
        }
      }
    },
  );

  it("provisions the chosen worktree and consumes its name for accepted native startup", async () => {
    replaceBrowserPreference("ws://gateway.example", "main", {
      workspace: "/repo",
      folder: "/repo",
      worktree: true,
      worktreeName: "ordinary-draft",
      baseRef: "main",
    });
    const { flow, place, request, context } = createNativeFixture({
      methods: ["sessions.catalog.startTerminal", "worktrees.create", "terminal.open"],
      agents: [{ id: "main", workspace: "/repo", workspaceGit: true }],
      request: async (method) => {
        if (method === "worktrees.branches") {
          return { repositoryStatus: "git", branches: ["main"], headBranch: "main" };
        }
        if (method === "worktrees.create") {
          return { path: "/repo/worktrees/native" };
        }
        return terminalOpenResult("native-worktree");
      },
    });
    mountNativeTerminal(context);
    await vi.waitFor(() => expect(place.repository.kind).toBe("git"));
    expect(place.worktreeName).toBe("");
    place.selectWorktree(true);
    place.setWorktreeName("native");
    place.setBaseRef("main");
    await flow.submit();
    expect(request).toHaveBeenCalledWith("worktrees.create", {
      repoRoot: "/repo",
      name: "native",
      baseRef: "main",
    });
    expectNativeStart(request, { cwd: "/repo/worktrees/native" });
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    expect(place).toMatchObject({ worktreeName: "", worktree: true, baseRef: "main" });
    expect(loadNewSessionPreference("ws://gateway.example", "main")?.worktreeName).toBe(
      "ordinary-draft",
    );
  });

  it("native launch preserves node ownership and refuses stale capabilities", async () => {
    const catalogId = "claude";
    const data = {
      ...nativeData,
      catalogId,
      catalogLabel: catalogId,
      terminalHosts: [{ hostId: "node:chosen", label: "Chosen" }],
    };
    const { context, flow, gateway, place, request } = createNativeFixture({
      data,
      agents: [{ id: "main", workspace: "/gateway-only" }],
      request: async () => terminalOpenResult("native-node"),
    });
    mountNativeTerminal(context);
    place.selectTerminalHost("node:chosen");
    expect(flow.submitDisabledReason()).toBeTruthy();
    place.applyFolder("/node/existing-project");
    const persistPreference = vi.spyOn(gateway, "persistPreference");
    request.mockClear();
    place.invalidateGatewayDiscovery(false);
    place.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
    expect(persistPreference).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    flow.setMessage("native prompt");
    await flow.submit();
    expectNativeStart(request, {
      catalogId,
      hostId: "node:chosen",
      cwd: "/node/existing-project",
      initialMessage: "native prompt",
    });
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    request.mockClear();
    data.terminalHosts = [];
    await flow.submit();
    expect(flow.blockedSubmitNotice()).toContain("Native CLI host unavailable");
    expect(request).not.toHaveBeenCalled();
    expect(place).toMatchObject({
      terminalHostId: "node:chosen",
      folder: "/node/existing-project",
    });

    // Same-route revalidation can retire the capability without changing the chosen node.
    data.startTerminal = false;
    data.catalogLabel = "";
    place.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
    request.mockClear();
    persistPreference.mockClear();
    place.applyFolder("/node/revalidated-project");
    expect(request).not.toHaveBeenCalled();
    expect(persistPreference).not.toHaveBeenCalled();
    expect(place).toMatchObject({
      terminalHostId: "node:chosen",
      folder: "/node/revalidated-project",
    });
    await flow.submit();
    expect(flow.blockedSubmitNotice()).toBe("This session target is unavailable.");
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["disabled", "attachments", "overrides", "mentions", "missing method", "non-admin"])(
    "native launch fails visibly for %s without Chat fallback",
    async (failure) => {
      const { context, flow, request } = createNativeFixture({
        scopes: failure === "non-admin" ? ["operator.write"] : ["operator.admin"],
        methods:
          failure === "missing method"
            ? ["sessions.create"]
            : ["sessions.catalog.startTerminal", "terminal.open"],
      });
      if (failure === "disabled") {
        context.config.current.cliAgentsEnabled = false;
      }
      if (failure === "attachments") {
        stubObjectUrls("blob:native-attachment");
        flow.attachmentDraft.replace([registerTextPayload("native-attachment")]);
      }
      if (failure === "overrides") {
        flow.capabilities.setToolOverrides({ skills: { release: false } });
      }
      const message =
        failure === "mentions" ? "@Alex do not turn this into Chat" : "do not turn this into Chat";
      flow.setMessage(
        message,
        failure === "mentions" ? [{ profileId: "profile-alex", start: 0, end: 5 }] : undefined,
      );
      await flow.submit();
      expect(flow.blockedSubmitNotice()).toBeTruthy();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(flow.message).toBe(message);
      if (failure === "mentions") {
        expect(flow.mentions).toEqual([{ profileId: "profile-alex", start: 0, end: 5 }]);
        expect(flow.blockedSubmitNotice()).toBe(
          "Human mentions are not available in this mode. Remove the selected mentions or send from a normal chat.",
        );
      }
      if (failure === "overrides") {
        flow.capabilities.setToolOverrides(null);
        expect(flow.canSubmit()).toBe(true);
      }
    },
  );
});
