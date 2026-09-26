import { beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCommittedSessionCategory } from "./session-create-category.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../session-groups.js", () => ({ ensureSessionGroupRegistered: vi.fn() }));
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));
vi.mock("./sessions-shared.js", () => ({ sessionLog: { warn: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());
const context = {} as GatewayRequestContext;
const source = { env: { OPENCLAW_STATE_DIR: "/fixture/state" }, assertCurrent: vi.fn() };

it.each([true, false])(
  "joins registration before catalog-only publication (changed=%s)",
  async (changed) => {
    const registration = createDeferredCore<boolean>();
    vi.mocked(ensureSessionGroupRegistered).mockReturnValueOnce(registration.promise);
    const publishing = registerCommittedSessionCategory("Travel", context, source);
    expect(emitSessionsChanged).not.toHaveBeenCalled();
    expect(ensureSessionGroupRegistered).toHaveBeenCalledWith(
      "Travel",
      source.env,
      source.assertCurrent,
    );
    registration.resolve(changed);
    await publishing;
    expect(source.assertCurrent).toHaveBeenCalledTimes(2);
    expect(emitSessionsChanged).toHaveBeenCalledTimes(changed ? 1 : 0);
    if (changed) {
      expect(emitSessionsChanged).toHaveBeenCalledWith(
        context,
        { reason: "groups" },
        { catalogOnly: true },
      );
    }
  },
);

it("warns and reloads only the catalog on uncertain registration, allowing explicit same-category repair", async () => {
  vi.mocked(ensureSessionGroupRegistered).mockRejectedValueOnce(new Error("catalog unavailable"));
  await expect(
    registerCommittedSessionCategory("Travel", context, source),
  ).resolves.toBeUndefined();
  expect(sessionLog.warn).toHaveBeenCalledWith(
    expect.stringContaining("retry the same category assignment"),
  );
  expect(emitSessionsChanged).toHaveBeenCalledWith(
    context,
    { reason: "groups" },
    { catalogOnly: true },
  );
  vi.mocked(ensureSessionGroupRegistered).mockResolvedValueOnce(true);
  await registerCommittedSessionCategory("Travel", context, source);
  expect(ensureSessionGroupRegistered).toHaveBeenCalledTimes(2);
  expect(emitSessionsChanged).toHaveBeenCalledTimes(2);
});

it("rejects revoked physical custody before registration and after its await", async () => {
  source.assertCurrent.mockImplementationOnce(() => {
    throw new Error("source closed");
  });
  await registerCommittedSessionCategory("Travel", context, source);
  expect(ensureSessionGroupRegistered).not.toHaveBeenCalled();
  source.assertCurrent
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error("source replaced");
    });
  await registerCommittedSessionCategory("Travel", context, source);
  expect(ensureSessionGroupRegistered).toHaveBeenCalledOnce();
  expect(sessionLog.warn).toHaveBeenCalledTimes(2);
});

it("does not register absent or cleared categories", async () => {
  await registerCommittedSessionCategory(undefined, context, source);
  await registerCommittedSessionCategory(" ", context, source);
  expect(ensureSessionGroupRegistered).not.toHaveBeenCalled();
});
