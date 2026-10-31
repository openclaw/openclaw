import { expectDefined } from "@openclaw/normalization-core";
import { createMemo, createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { createNativeNotificationsCapability } from "../../app/native-notifications.ts";
import { terminalOpenResult } from "../../components/terminal/terminal-panel.test-support.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { PaletteDraftHost } from "../../test-helpers/palette-session-draft.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import {
  createDraftFixture,
  readyChatRoute,
  resetSubmissionMocks,
} from "./draft-submission-flow.test-support.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import { mountProjectChip } from "./project-chip.test-support.tsx";
import { createSubmissionAction, type SubmissionPresentation } from "./submission-action.ts";
import { pickerParams } from "./where-chip.test-support.ts";
import { WhereChip } from "./where-chip.tsx";

afterEach(resetSubmissionMocks);

it("retains environment heading and device artwork through unrelated refreshes", async () => {
  const params = pickerParams(true, undefined, { cloudProfiles: [] });
  const [current, setCurrent] = createSignal(params);
  const view = mountSolid(() => <WhereChip {...current()} />);
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(view.container.querySelector(".new-session-page__environment-list")).not.toBeNull(),
  );
  const list = view.container.querySelector(".new-session-page__environment-list")!;
  const row = list.querySelector('[data-value="device:runner"]')!;
  const observer = new MutationObserver(() => {});
  observer.observe(list, { subtree: true, childList: true });
  onTestFinished(() => observer.disconnect());
  setCurrent({ ...params });
  flush();
  expect(observer.takeRecords()).toHaveLength(0);

  const refreshed = { ...params.state.devices[0]!, label: "Build MacBook Pro", platform: "darwin" };
  setCurrent({
    ...params,
    state: {
      ...params.state,
      devices: params.state.devices.map((device) =>
        device.deviceId === "runner" ? refreshed : device,
      ),
    },
  });
  flush();
  expect(list.querySelector('[data-value="device:runner"]')).toBe(row);
  expect(row.textContent).toContain("Build MacBook Pro");
  expect(row.querySelector('[data-form="laptop"]')).not.toBeNull();
});

it("retains project artwork while current labels and selection remain live", async () => {
  const projects = [
    {
      id: "sample",
      displayName: "Sample Project",
      repoRoot: "/fixture/sample",
      source: "registered" as const,
    },
  ];
  const fixture = createRepositoryFixture();
  const { browser, changed } = fixture;
  vi.spyOn(browser, "projects", "get").mockReturnValue(projects);
  vi.spyOn(browser, "projectsReady", "get").mockReturnValue(true);
  browser.changeProjectQuery("Sample");
  vi.spyOn(browser, "popoverOpen").mockReturnValue(true);
  const view = mountProjectChip(fixture, () => ({
    folder: "",
    workspace: "/fixture",
    projectId: "",
    selectedRemoteProject: null,
    projects,
    recents: [],
    projectQuery: "Sample",
  }));
  await waitForSolid(() =>
    expect(view.container.querySelector('[data-value="project:sample"]')).not.toBeNull(),
  );
  const row = view.container.querySelector('[data-value="project:sample"]')!;
  const observer = new MutationObserver(() => {});
  observer.observe(row, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  changed();
  flush();
  expect(observer.takeRecords()).toHaveLength(0);
  projects[0]!.displayName = "Sample Project refreshed";
  browser.selectProject({ kind: "local", id: "sample" });
  changed();
  flush();
  expect(view.container.querySelector('[data-value="project:sample"]')).toBe(row);
  expect(row.textContent).toContain("Sample Project refreshed");
  expect(row.getAttribute("aria-pressed")).toBe("true");
});

function notificationFixture(surface: "web" | "native") {
  const fixture = createDraftFixture();
  const permissionGestures: (Event | undefined)[] = [];
  const browserPermission = vi.fn(() => {
    permissionGestures.push(window.event);
    return Promise.resolve("granted" as NotificationPermission);
  });
  vi.stubGlobal("Notification", { requestPermission: browserPermission });
  const postMessage = vi.fn((message: { type: string }) => {
    if (message.type === "request-permission") {
      permissionGestures.push(window.event);
    }
  });
  if (surface === "native") {
    vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
    vi.stubGlobal("__OPENCLAW_NATIVE_NOTIFICATIONS__", { permission: "notDetermined", test: null });
  }
  const nativeNotifications = surface === "native" ? createNativeNotificationsCapability() : null;
  onTestFinished(() => nativeNotifications?.dispose());
  const enable = vi.fn(async () => undefined);
  const webPush = {
    snapshot: {
      supported: true,
      canManage: true,
      permission: "default",
      subscription: "unknown",
      loading: false,
    },
    run: enable,
  };
  Object.assign(fixture.context, { nativeNotifications, webPush });
  vi.mocked(fixture.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:notification-onboarding",
    initialRun: { status: "idle" },
  });
  vi.mocked(fixture.context.navigateAndWait).mockImplementation(readyChatRoute);
  fixture.flow.setMessage("Start the first conversation");
  return { ...fixture, browserPermission, enable, permissionGestures };
}

function submitFromClick(flow: DraftSubmissionFlow, background = false) {
  const button = document.createElement("button");
  let submission: ReturnType<DraftSubmissionFlow["submit"]> | undefined;
  button.addEventListener("click", () => {
    submission = flow.submit(undefined, background);
  });
  button.click();
  return expectDefined(submission, "clicked New Session submission");
}

it.each([
  ["web", true],
  ["native", false],
] as const)(
  "prompts %s synchronously and only once (background=%s)",
  async (surface, background) => {
    const { context, flow, enable, permissionGestures } = notificationFixture(surface);

    const first = submitFromClick(flow, background);

    expect(permissionGestures.map((event) => event?.type)).toEqual(["click"]);
    expect(enable).not.toHaveBeenCalled();
    await first;
    expect(enable.mock.calls).toEqual(surface === "web" ? [[{ kind: "enable" }]] : []);

    flow.setMessage("Start another conversation");
    await submitFromClick(flow, background);

    expect(context.sessions.createResult).toHaveBeenCalledTimes(2);
    expect(permissionGestures).toHaveLength(1);
  },
);

it.each(["programmatic", "empty", "command", "blocked"] as const)(
  "does not prompt on %s submission",
  async (scenario) => {
    const { context, flow, browserPermission, enable } = notificationFixture("web");
    if (scenario === "empty") {
      flow.setMessage("");
    } else if (scenario === "command") {
      flow.setMessage("/status");
    } else if (scenario === "blocked") {
      flow.attachmentDraft.reads.updatePending(flow.attachmentDraft.reads.readSignal, 1);
    }

    await (scenario === "programmatic" ? flow.submit() : submitFromClick(flow));

    expect([browserPermission.mock.calls, enable.mock.calls]).toEqual([[], []]);
    if (scenario === "blocked") {
      expect(context.sessions.createResult).not.toHaveBeenCalled();
    }
  },
);

it("preserves draft intent through failed defaults refresh and agent replacement", async () => {
  const fresh = createDeferred<AgentsListResult>();
  const retry = createDeferred<AgentsListResult>();
  let requested = false;
  const { context } = createDraftFixture({
    request: (method) => {
      if (method === "environments.list") {
        return Promise.resolve({ profiles: [], environments: [] });
      }
      if (method !== "agents.list") {
        return Promise.resolve({ repositoryStatus: "not_git", branches: [] });
      }
      const result = requested ? retry.promise : fresh.promise;
      requested = true;
      return result;
    },
  });
  const agents = createAgentCapability(context.gateway);
  Object.assign(context, {
    agents,
    agentIdentity: {
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
      get: () => undefined,
    },
    navigate: vi.fn(),
  });
  vi.mocked(context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:warm-roster",
    initialRun: { status: "idle" },
  });
  let read = agents.ensureList();
  const host = new PaletteDraftHost(context);
  onTestFinished(() => {
    host.remove();
    agents.dispose();
  });
  host.draft.open();
  await waitForSolid(() =>
    expect(host.querySelector(".palette-session-settings__workspace")).not.toBeNull(),
  );
  const expectBlocked = async (disabledReason: string) => {
    expect(host.draft).toMatchObject({ canSubmit: false, disabledReason, error: null });
    await host.draft.submit();
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    expect(host.draft.error).toBeNull();
  };
  host.draft.setMessage("Keep this draft while defaults refresh");
  await expectBlocked("Refreshing agent defaults…");

  fresh.reject(new Error("roster temporarily unavailable"));
  await read;
  await host.updateComplete;
  await expectBlocked("Could not refresh agent defaults. Reload to try again.");
  read = agents.ensureList();
  retry.resolve({
    defaultId: "replacement",
    mainKey: "main",
    scope: "per-sender",
    agents: [
      {
        id: "replacement",
        workspace: "/workspace-b",
        workspaceGit: false,
        model: { primary: "openai/gpt-5.5" },
      },
    ],
    sessionPlacement: {},
  });
  await read;
  await host.updateComplete;
  await host.updateComplete;
  await host.draft.submit();
  expect(context.sessions.createResult).toHaveBeenCalledOnce();
  const params = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
  expect(params).toMatchObject({
    agentId: "replacement",
    message: "Keep this draft while defaults refresh",
  });
  expect(params).not.toHaveProperty("cwd");
});

it("releases retired native startup presentation before its owner receives the late PTY", async () => {
  const starting = Promise.withResolvers<ReturnType<typeof terminalOpenResult>>();
  const closing = Promise.withResolvers<void>();
  const requested = createDeferred();
  const { flow, context, request, changed } = createDraftFixture({
    scopes: ["operator.admin"],
    methods: ["sessions.catalog.startTerminal", "terminal.open"],
    data: {
      agentId: "main",
      requestedAgentId: "main",
      catalogId: "codex",
      catalogLabel: "Codex",
      startTerminal: true,
      terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
    },
    request: async (method) => {
      if (method === "sessions.catalog.startTerminal") {
        requested.resolve();
        return starting.promise;
      }
      return method === "terminal.close" ? closing.promise : {};
    },
  });
  Object.assign(context.gateway.snapshot.client!, { addEventListener: () => () => {} });
  let lifetime = Promise.withResolvers<void>();
  const owner: SubmissionPresentation = {
    get submissionLifetime() {
      return lifetime.promise;
    },
  };
  let operationFinished = false;
  const view = mountSolid(() => {
    const [revision, publish] = createSignal(0);
    changed.mockImplementation(() => publish((value) => value + 1));
    const outcome = createMemo(() => {
      revision();
      return flow.error;
    });
    const saving = createSubmissionAction(
      () => owner,
      revision,
      outcome,
      (error) => flow.setError(String(error)),
    );
    return <p role="status">{saving() ? "Starting native terminal" : "Ready"}</p>;
  });
  await waitForSolid(() => expect(owner.presentSubmit).toBeTypeOf("function"));
  flow.setMessage("Keep this unsent draft");
  const presenting = owner.presentSubmit!(async () => {
    await flow.submit();
    operationFinished = true;
  });
  const expectPresentation = (text: string) =>
    waitForSolid(() => expect(view.getByRole("status").textContent).toBe(text));
  await requested.promise;
  await expectPresentation("Starting native terminal");

  flow.invalidate("gateway-changed");
  lifetime.resolve();
  lifetime = Promise.withResolvers<void>();
  changed();
  await expectPresentation("Ready");
  expect(operationFinished).toBe(false);
  starting.resolve(terminalOpenResult("late-native-start"));
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: "late-native-start" }),
  );
  await presenting;
  expect(operationFinished).toBe(true);
  closing.resolve();
  expect(flow.message).toBe("Keep this unsent draft");
  expect(context.replace).not.toHaveBeenCalled();
  expect(context.sessions.createResult).not.toHaveBeenCalled();
});
