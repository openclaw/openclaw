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
  refine: vi.fn<
    (typeof import("../dashboard-session-title-refinement.js"))["maybeRefineDashboardSessionTitle"]
  >(async () => undefined),
}));

vi.mock("../../process/gateway-work-admission.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWithGatewayIndependentRootWorkContinuation: (work: () => Promise<unknown>) => work(),
}));
vi.mock("../dashboard-session-title.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  maybeGenerateDashboardSessionTitle: title.generate,
}));
vi.mock("../dashboard-session-title-refinement.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  maybeRefineDashboardSessionTitle: title.refine,
}));
vi.mock("./session-change-event.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitSessionTitleChanged: vi.fn(),
}));

const context = { logGateway: { warn: vi.fn() } } as unknown as GatewayRequestContext;

test("created-session title skips its opening refinement message without changing ordinary chat titles", async () => {
  const cfg = {} as OpenClawConfig;
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

test("attachment-only accepted turns count toward refinement via a bounded descriptor (4304147111)", async () => {
  const cfg = {} as OpenClawConfig;
  // Empty text + a non-text attachment: buildDashboardSessionTitleSource
  // yields no title text, but the turn is a real task and must still reach
  // refinement counting with a bounded attachment-descriptor source.
  title.generate.mockResolvedValue(false);
  scheduleChatDashboardSessionTitle({
    admittedSessionId: "attachment-session",
    agentId: "main",
    cfg,
    context,
    request: {
      rawMessage: "",
      normalizedAttachments: [{ mimeType: "image/png", fileName: "diagram.png", content: "aGk=" }],
    },
    sessionKey: "agent:main:dashboard:attachment",
    storePath: "/tmp/sessions.json",
  });
  await vi.waitFor(() => expect(title.refine).toHaveBeenCalledOnce());
  const refinedParams = title.refine.mock.calls[0]?.[0];
  expect(refinedParams?.userMessage).toBe("[attachment: image/png diagram.png]");
  // Title generation is not claimed for the descriptor; the generation pass
  // receives the (empty) text source unchanged.
  expect(title.generate).toHaveBeenCalledWith(expect.objectContaining({ userMessage: "" }));
});

test("turns with neither text nor attachments are still not scheduled", async () => {
  const cfg = {} as OpenClawConfig;
  title.generate.mockClear();
  title.refine.mockClear();
  scheduleChatDashboardSessionTitle({
    admittedSessionId: "empty-session",
    agentId: "main",
    cfg,
    context,
    request: { rawMessage: "", normalizedAttachments: [] },
    sessionKey: "agent:main:dashboard:empty",
    storePath: "/tmp/sessions.json",
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });
  expect(title.generate).not.toHaveBeenCalled();
  expect(title.refine).not.toHaveBeenCalled();
});
