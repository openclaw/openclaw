import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createNativeNotificationsCapability } from "../../app/native-notifications.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
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
      canReadPreferences: true,
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
  vi.mocked(fixture.context.navigateAndWait).mockImplementation(async () => {
    queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
  });
  fixture.flow.setMessage("Start the first conversation");
  return { ...fixture, browserPermission, enable, permissionGestures, postMessage };
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
    const { context, flow, browserPermission, enable, permissionGestures, postMessage } =
      notificationFixture(surface);

    const first = submitFromClick(flow, background);

    expect(permissionGestures.map((event) => event?.type)).toEqual(["click"]);
    expect(enable).not.toHaveBeenCalled();
    await first;
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(browserPermission).toHaveBeenCalledTimes(surface === "web" ? 1 : 0);
    expect(enable.mock.calls).toEqual(surface === "web" ? [[{ kind: "enable" }]] : []);
    if (surface === "native") {
      expect(postMessage).toHaveBeenCalledWith({ type: "request-permission" });
    }

    flow.setMessage("Start another conversation");
    await submitFromClick(flow, background);

    expect(context.sessions.createResult).toHaveBeenCalledTimes(2);
    expect(permissionGestures).toHaveLength(1);
  },
);

it.each(["programmatic", "empty", "command", "blocked"] as const)(
  "does not spend the first-send prompt on a %s submission",
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
