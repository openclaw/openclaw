import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("DraftSubmissionFlow permission selection", () => {
  it("preserves navigation recovery until the user changes permission mode", async () => {
    const { context, flow, requestUpdate } = createDraftFixture({
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:permissions",
      initialRun: { status: "idle" },
    });
    vi.mocked(context.navigateAndWait).mockRejectedValue(new Error("Chat route unavailable"));
    const restore = () =>
      flow.restoreDraftState({
        message: "Continue with this permission mode",
        attachments: [],
        visibility: "normal",
        permissionMode: "guarded",
      });
    try {
      restore();
      await flow.submit();
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      expect(context.sessions.createResult).toHaveBeenLastCalledWith(
        expect.objectContaining({ permissionMode: "guarded" }),
        expect.anything(),
      );

      restore();
      await flow.submit();
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      expect(context.navigateAndWait).toHaveBeenCalledTimes(2);

      requestUpdate.mockClear();
      flow.setPermissionMode("full");
      expect(requestUpdate).toHaveBeenCalledOnce();
      await flow.submit();
      expect(context.sessions.createResult).toHaveBeenCalledTimes(2);
      expect(context.sessions.createResult).toHaveBeenLastCalledWith(
        expect.objectContaining({ permissionMode: "full" }),
        expect.anything(),
      );
    } finally {
      flow.disconnect();
    }
  });
});
