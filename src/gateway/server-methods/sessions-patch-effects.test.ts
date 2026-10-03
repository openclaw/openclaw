import { beforeEach, expect, it, vi } from "vitest";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { registerCommittedSessionCategory } from "./session-create-category.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../session-groups.js", () => ({ ensureSessionGroupRegistered: vi.fn() }));
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));
vi.mock("./sessions-shared.js", () => ({ sessionLog: { warn: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());
const context = {} as GatewayRequestContext;
const source = { env: { OPENCLAW_STATE_DIR: "/fixture/state" }, assertCurrent: vi.fn() };

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
