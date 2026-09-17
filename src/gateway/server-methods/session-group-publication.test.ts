import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { registerCreatedSessionCategory } from "./session-create-category.js";
import { publishSessionPatchEffects } from "./sessions-patch-effects.js";

const effects = vi.hoisted(() => ({
  register: vi.fn<(name: string) => Promise<boolean>>(),
  emit: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../session-groups.js", () => ({ ensureSessionGroupRegistered: effects.register }));
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: effects.emit }));
vi.mock("./sessions-shared.js", () => ({ sessionLog: { warn: effects.warn } }));
vi.mock("../session-patch-hooks.js", () => ({ triggerSessionPatchHook() {} }));
vi.mock("./sessions-patch-model-selection.js", () => ({ persistSessionPatchModelSelection() {} }));
vi.mock("../../cron/job-session-bindings.js", () => ({ disableCronJobsBoundToSessions: vi.fn() }));

const context = createDirectChatContext();

function publish(kind: "create" | "patch"): Promise<void> {
  if (kind === "create") {
    return registerCreatedSessionCategory("Research", context);
  }
  return publishSessionPatchEffects({
    cfg: {},
    context,
    callerScopes: [],
    callerCanManageCron: false,
    category: "Research",
    targets: [
      {
        accessChanged: false,
        entry: { sessionId: "committed", updatedAt: 1, category: "Research" },
        target: {
          canonicalKey: "agent:main:dashboard:committed",
          targetAgentId: "main",
          fullPatch: { key: "agent:main:dashboard:committed", category: "Research" },
        },
      },
    ],
  });
}

function groupEvents() {
  return effects.emit.mock.calls.filter(([, event]) => event.reason === "groups");
}

beforeEach(() => vi.clearAllMocks());

describe("committed session category publication", () => {
  it.each([
    { kind: "create" as const, inserted: true },
    { kind: "create" as const, inserted: false },
    { kind: "patch" as const, inserted: true },
    { kind: "patch" as const, inserted: false },
  ])(
    "joins $kind registration before publishing inserted=$inserted",
    async ({ kind, inserted }) => {
      const registration = createDeferredCore<boolean>();
      effects.register.mockReturnValueOnce(registration.promise);
      const publishing = Promise.resolve(publish(kind));
      try {
        expect(groupEvents()).toHaveLength(0);
      } finally {
        registration.resolve(inserted);
        await publishing;
      }
      expect(groupEvents()).toHaveLength(inserted ? 1 : 0);
    },
  );

  it("keeps create bookkeeping failures warning-only after the session commit", async () => {
    effects.register.mockRejectedValueOnce(new Error("registration unavailable"));
    await expect(publish("create")).resolves.toBeUndefined();
    expect(groupEvents()).toHaveLength(0);
    expect(effects.warn).toHaveBeenCalledExactlyOnceWith(
      "failed to register created session category: registration unavailable",
    );
  });

  it("preserves patch bookkeeping rejection without publishing a groups event", async () => {
    const error = new Error("registration unavailable");
    effects.register.mockRejectedValueOnce(error);
    await expect(publish("patch")).rejects.toBe(error);
    expect(groupEvents()).toHaveLength(0);
    expect(effects.warn).not.toHaveBeenCalled();
  });
});
