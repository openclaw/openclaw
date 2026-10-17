import { expect, test, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionTitleParams } from "../dashboard-session-title.js";
import {
  scheduleChatDashboardSessionTitle,
  scheduleCreatedDashboardSessionTitle,
} from "./chat-send-background.js";
import type { GatewayRequestContext } from "./types.js";

const title = vi.hoisted(() => ({
  generate: vi.fn<(params: SessionTitleParams) => Promise<boolean>>(async () => true),
}));
vi.mock("../../process/gateway-work-admission.js", () => ({
  runWithGatewayIndependentRootWorkContinuation: (work: () => Promise<void>) => work(),
}));
vi.mock("../dashboard-session-title.js", () => ({
  buildDashboardSessionTitleSource: ({ message }: { message: string }) => message,
  isDashboardSessionTitleCandidate: () => true,
  maybeGenerateDashboardSessionTitle: title.generate,
}));
vi.mock("../dashboard-session-title-refinement.js", () => ({
  maybeRefineDashboardSessionTitle: vi.fn(),
}));
vi.mock("./session-change-event.js", () => ({ emitSessionTitleChanged: vi.fn() }));

test("created-session title skips its opening refinement message without changing ordinary chat titles", async () => {
  const cfg = {} as OpenClawConfig;
  const context = { logGateway: { warn: vi.fn() } } as unknown as GatewayRequestContext;
  const entry = { sessionId: "created-session" } as SessionEntry;
  scheduleCreatedDashboardSessionTitle(
    {
      key: "agent:main:dashboard:created",
      agentId: "main",
      entry,
      storePath: "/tmp/sessions.json",
      isNew: true,
    },
    cfg,
    context,
    "Opening task",
  );
  await vi.waitFor(() => expect(title.generate).toHaveBeenCalledOnce());
  expect(title.generate).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: entry.sessionId,
      userMessage: "Opening task",
      skipNextRefinementMessage: true,
    }),
  );

  title.generate.mockClear();
  scheduleChatDashboardSessionTitle({
    admittedSessionId: "ordinary-session",
    agentId: "main",
    cfg,
    context,
    request: { rawMessage: "Ordinary first task", normalizedAttachments: [] },
    sessionKey: "agent:main:dashboard:ordinary",
    storePath: "/tmp/sessions.json",
  });
  await vi.waitFor(() => expect(title.generate).toHaveBeenCalledOnce());
  expect(title.generate.mock.calls[0]?.[0]).not.toHaveProperty("skipNextRefinementMessage");
});
