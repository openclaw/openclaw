import { beforeEach, describe, expect, it, vi } from "vitest";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { publishSessionPatchEffects } from "./sessions-patch-effects.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../cron/job-session-bindings.js", () => ({ disableCronJobsBoundToSessions: vi.fn() }));
vi.mock("../session-groups.js", () => ({ ensureSessionGroupRegistered: vi.fn() }));
vi.mock("../session-patch-hooks.js", () => ({ triggerSessionPatchHook: vi.fn() }));
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));
vi.mock("./sessions-patch-model-selection.js", () => ({
  persistSessionPatchModelSelection: vi.fn(),
}));
vi.mock("./sessions-shared.js", () => ({ sessionLog: { warn: vi.fn(), info: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(disableCronJobsBoundToSessions).mockResolvedValue(new Map());
});

describe("committed category patch effects", () => {
  function params(): Parameters<typeof publishSessionPatchEffects>[0] {
    return {
      cfg: {},
      context: { cron: {} } as GatewayRequestContext,
      callerScopes: [],
      callerCanManageCron: true,
      category: "Travel",
      targets: [
        {
          accessChanged: false,
          entry: { sessionId: "saved", updatedAt: 1, category: "Travel", archivedAt: 1 },
          target: {
            canonicalKey: "agent:main:travel",
            targetAgentId: "main",
            fullPatch: { key: "agent:main:travel", category: "Travel", archived: true },
          },
        },
      ],
    };
  }

  it.each([true, false])(
    "joins category registration before publishing inserted=%s",
    async (inserted) => {
      const registration = createDeferredCore<boolean>();
      vi.mocked(ensureSessionGroupRegistered).mockReturnValueOnce(registration.promise);
      const publishing = publishSessionPatchEffects(params());
      try {
        expect(emitSessionsChanged).toHaveBeenCalledOnce();
        expect(disableCronJobsBoundToSessions).not.toHaveBeenCalled();
      } finally {
        registration.resolve(inserted);
        await publishing;
      }
      expect(
        vi.mocked(emitSessionsChanged).mock.calls.filter(([, event]) => event.reason === "groups"),
      ).toHaveLength(inserted ? 1 : 0);
      expect(disableCronJobsBoundToSessions).toHaveBeenCalledOnce();
    },
  );

  it("preserves the committed patch and remaining effects when catalog registration fails", async () => {
    vi.mocked(ensureSessionGroupRegistered).mockRejectedValueOnce(new Error("catalog unavailable"));
    const patch = params();

    await expect(publishSessionPatchEffects(patch)).resolves.toBeUndefined();

    expect(patch.targets[0]?.entry.category).toBe("Travel");
    expect(emitSessionsChanged).toHaveBeenCalledWith(
      patch.context,
      { sessionKey: "agent:main:travel", reason: "patch" },
      { accessChanged: false },
    );
    expect(emitSessionsChanged).toHaveBeenCalledWith(
      patch.context,
      { reason: "groups" },
      { catalogOnly: true },
    );
    expect(sessionLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("retry the same category assignment"),
    );
    expect(disableCronJobsBoundToSessions).toHaveBeenCalledOnce();

    // A repeated assignment still invokes the catalog owner and publishes recovery.
    vi.mocked(ensureSessionGroupRegistered).mockResolvedValueOnce(true);
    await publishSessionPatchEffects(patch);
    expect(ensureSessionGroupRegistered).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(emitSessionsChanged).mock.calls.filter(([, event]) => event.reason === "groups"),
    ).toHaveLength(2);
  });

  it("does not publish a catalog change when the group already exists", async () => {
    vi.mocked(ensureSessionGroupRegistered).mockResolvedValue(false);
    await publishSessionPatchEffects(params());
    expect(emitSessionsChanged).toHaveBeenCalledOnce();
  });

  it("does not register a category when no target committed", async () => {
    await publishSessionPatchEffects({ ...params(), targets: [] });
    expect(ensureSessionGroupRegistered).not.toHaveBeenCalled();
    expect(emitSessionsChanged).not.toHaveBeenCalled();
  });
});
