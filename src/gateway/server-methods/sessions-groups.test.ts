import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const groupMocks = vi.hoisted(() => ({
  NotEmpty: class SessionGroupNotEmptyError extends Error {},
  NotFound: class SessionGroupNotFoundError extends Error {},
  put: vi.fn(),
  rename: vi.fn(),
  update: vi.fn(),
  defaults: vi.fn<() => Array<{ name: string; cwd?: string; worktree?: boolean }>>(() => []),
}));
const pathMocks = vi.hoisted(() => ({
  isCurrent: vi.fn(),
  resolveContainment: vi.fn(),
}));

vi.mock("../session-groups.js", () => ({
  deleteSessionGroup: vi.fn(),
  putSessionGroups: groupMocks.put,
  renameSessionGroup: groupMocks.rename,
  SessionGroupNotEmptyError: groupMocks.NotEmpty,
  SessionGroupNotFoundError: groupMocks.NotFound,
  updateSessionGroupDefaults: groupMocks.update,
}));
vi.mock("../session-group-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-group-catalog.js")>()),
  readSessionGroupCatalog: () => ({
    groups: [],
    defaults: groupMocks.defaults(),
    sectionOrder: [],
  }),
}));
vi.mock("../session-group-defaults-access.js", () => ({
  filterMutableSessionGroupRecords: async ({ records }: { records: () => unknown[] }) => records(),
}));
vi.mock("./workspace-path-containment.js", () => ({
  isWorkspacePathContainmentCurrent: pathMocks.isCurrent,
  resolveWorkspacePathContainment: pathMocks.resolveContainment,
}));

import { sessionGroupHandlers } from "./sessions-groups.js";

const containment = { path: "/workspace/client", workspaceRoot: "/workspace" };
const invalidCwd = { code: "INVALID_REQUEST" };
const missingGroup = { code: "INVALID_REQUEST", message: "unknown session group: Travel" };
const adminRequired = { message: expect.stringContaining("operator.admin") };

function expectFailure(respond: ReturnType<typeof vi.fn>, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function groupRequest(
  method: keyof typeof sessionGroupHandlers,
  params: Record<string, unknown>,
  scopes = ["operator.write", "operator.admin"],
) {
  const respond = vi.fn();
  const options = {
    params,
    respond,
    ...(method === "sessions.groups.rename" ? {} : { client: { connect: { scopes } } }),
    context: {
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    },
  } as unknown as GatewayRequestHandlerOptions;
  return {
    options,
    respond,
    invoke: () => sessionGroupHandlers[method]!(options),
  };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  groupMocks.put.mockReset();
  groupMocks.rename.mockReset();
  groupMocks.update.mockReset();
  groupMocks.defaults.mockReset().mockReturnValue([]);
  pathMocks.isCurrent.mockReset().mockReturnValue(true);
  pathMocks.resolveContainment.mockReset();
});

describe("sessions.groups.put", () => {
  it("rejects dropping a non-empty group as an invalid request", async () => {
    const message = "cannot drop Gone; remove it via sessions.groups.delete";
    groupMocks.put.mockImplementation(() => {
      throw new groupMocks.NotEmpty(message);
    });
    const h = groupRequest("sessions.groups.put", { names: ["Keep"] });
    await h.invoke();
    expectFailure(h.respond, { code: "INVALID_REQUEST", message });
  });

  it("rethrows changed authorization instead of mapping it to an unavailable response", async () => {
    const error = new SessionMutationAuthorizationChangedError({
      code: "INVALID_REQUEST",
      message: "session changed before sessions.groups.put; retry the request",
    });
    const assertCurrent = vi.fn(() => {
      throw error;
    });
    const assertTargetCurrent = vi.fn();
    groupMocks.put.mockImplementation((options) => {
      expect(options.assertTargetCurrent).toBe(assertTargetCurrent);
      options.assertCurrent();
    });
    const h = groupRequest("sessions.groups.put", { names: [] });
    h.options.sessionMutationAuthorization = { assertCurrent, assertTargetCurrent };
    await expect(h.invoke()).rejects.toBe(error);
    expect(h.respond).not.toHaveBeenCalled();
  });
});

describe("sessions.groups.update", () => {
  it.each([
    ["relative", "tmp/travel", false, true, 0, invalidCwd],
    ["stale", "/tmp/travel", true, true, 1, missingGroup],
    ["outside", "/outside/travel", false, false, 0, adminRequired],
  ] as const)(
    "rejects %s without creating defaults",
    async (_name, cwd, worktree, admin, calls, error) => {
      if (calls) {
        groupMocks.update.mockReturnValue(null);
      }
      if (!admin) {
        pathMocks.resolveContainment.mockResolvedValue(null);
      }
      const h = groupRequest(
        "sessions.groups.update",
        { name: "Travel", cwd, worktree },
        admin ? ["operator.write", "operator.admin"] : ["operator.write"],
      );
      await h.invoke();
      expect(groupMocks.update).toHaveBeenCalledTimes(calls);
      expectFailure(h.respond, error);
    },
  );

  it("persists the canonical workspace-contained cwd for a write caller", async () => {
    pathMocks.resolveContainment.mockResolvedValue(containment);
    groupMocks.update.mockImplementation((_name, _defaults, _env, assertCurrent) => {
      assertCurrent();
      const records = [{ name: "Client", cwd: "/workspace/client", worktree: true }];
      groupMocks.defaults.mockReturnValue(records);
      return records;
    });
    const assertCurrent = vi.fn();
    const h = groupRequest(
      "sessions.groups.update",
      { name: "Client", cwd: "/workspace/link", worktree: true },
      ["operator.write"],
    );
    h.options.sessionMutationAuthorization = {
      assertCurrent,
      assertTargetCurrent: vi.fn(),
    };
    await h.invoke();

    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(groupMocks.update.mock.calls[0]?.[1]).toEqual({
      cwd: "/workspace/client",
      worktree: true,
    });
    expect(h.respond).toHaveBeenCalledWith(
      true,
      { ok: true, defaults: [{ name: "Client", cwd: "/workspace/client", worktree: true }] },
      undefined,
    );
  });

  it("rejects containment retired by a runtime config change before commit", async () => {
    const pending = createDeferred<typeof containment>();
    pathMocks.resolveContainment.mockReturnValue(pending.promise);
    const initialConfig = { agents: { defaults: { workspace: "/workspace" } } };
    const retiredConfig = { agents: { defaults: { workspace: "/replacement" } } };
    let runtimeConfig = initialConfig;
    pathMocks.isCurrent.mockImplementation((_containment, cfg) => cfg === initialConfig);
    const h = groupRequest(
      "sessions.groups.update",
      { name: "Client", cwd: "/workspace/client", worktree: true },
      ["operator.write"],
    );
    h.options.context.getRuntimeConfig = () => runtimeConfig;
    const update = h.invoke();

    await vi.waitFor(() => expect(pathMocks.resolveContainment).toHaveBeenCalledOnce());
    runtimeConfig = retiredConfig;
    pending.resolve(containment);
    await update;

    expect(pathMocks.isCurrent).toHaveBeenCalledWith(containment, retiredConfig);
    expect(groupMocks.update).not.toHaveBeenCalled();
    expectFailure(h.respond, { message: expect.stringContaining("operator.admin") });
  });
});

it("sessions.groups.rename rejects an unknown source group", async () => {
  groupMocks.rename.mockRejectedValue(new groupMocks.NotFound("unknown session group: Missing"));
  const h = groupRequest("sessions.groups.rename", { name: "Missing", to: "Other" });
  await h.invoke();
  expectFailure(h.respond, {
    code: "INVALID_REQUEST",
    message: "unknown session group: Missing",
  });
});
