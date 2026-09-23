import { afterEach, expect, test, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../../packages/gateway-protocol/src/index.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail, setAvatar } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "./types.js";
import { usersHandlers } from "./users.js";

async function invokePreferenceMethod(
  method: "users.prefs.get" | "users.prefs.set",
  params: Record<string, unknown>,
  profileId?: string,
  context: Record<string, unknown> = {},
) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await usersHandlers[method]!({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: context as never,
    client: {
      connect: { scopes: ["operator.admin"] },
      ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
    } as never,
    isWebchatConnect: () => false,
  });
  return result;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("users.prefs remains self-scoped across durable identities", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-prefs-rpc-" });
  try {
    const ada = ensureProfileForEmail("ada@example.test");
    const grace = ensureProfileForEmail("grace@example.test");
    const prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
    expect(
      await invokePreferenceMethod(
        "users.prefs.set",
        { entries: { "new-session.v1:main": { folder: "/ada" } } },
        ada.id,
      ),
    ).toEqual({ ok: true, payload: { status: "ok" }, error: undefined });
    expect(await invokePreferenceMethod("users.prefs.get", {}, ada.id)).toMatchObject({
      ok: true,
      payload: {
        status: "ok",
        entries: { "new-session.v1:main": { folder: "/ada" } },
      },
    });
    expect(await invokePreferenceMethod("users.prefs.get", {}, grace.id)).toMatchObject({
      ok: true,
      payload: { status: "ok", entries: {} },
    });
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    linkEmail("ada@example.test", grace.id);
    expect(await invokePreferenceMethod("users.prefs.get", {}, grace.id)).toMatchObject({
      ok: true,
      payload: {
        status: "ok",
        entries: { "new-session.v1:main": { folder: "/ada" } },
      },
    });
  } finally {
    await state.cleanup();
  }
});

test("users.prefs returns a typed result without a durable identity", async () => {
  const context = { broadcastToConnIds: vi.fn(), getClientConnIds: vi.fn() };
  expect(await invokePreferenceMethod("users.prefs.get", {}, undefined, context)).toMatchObject({
    ok: true,
    payload: { status: "no_durable_identity" },
  });
  expect(
    await invokePreferenceMethod(
      "users.prefs.set",
      { entries: { theme: "claw" } },
      undefined,
      context,
    ),
  ).toMatchObject({
    ok: true,
    payload: { status: "no_durable_identity" },
  });
  expect(context.getClientConnIds).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalled();
});

test("users.prefs.set notifies only connections belonging to the same merged profile", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-events-",
  });
  try {
    const retired = ensureProfileForEmail("retired@example.test");
    const owner = ensureProfileForEmail("owner@example.test");
    const other = ensureProfileForEmail("other@example.test");
    const avatar = new Uint8Array(64 * 1024).fill(0x7f);
    for (const profile of [retired, owner, other]) {
      expect(setAvatar(profile.id, avatar, "image/png").ok).toBe(true);
    }
    linkEmail("retired@example.test", owner.id);

    const connectedClients = [
      { connId: "owner", authenticatedUserProfile: { profileId: owner.id } },
      { connId: "merged", authenticatedUserProfile: { profileId: retired.id } },
      { connId: "other", authenticatedUserProfile: { profileId: other.id } },
      { connId: "unbound" },
    ];
    const broadcastToConnIds = vi.fn();
    const context = {
      broadcastToConnIds,
      getClientConnIds: (filter: (client: GatewayClient) => boolean) =>
        new Set(
          connectedClients
            .filter((client) => filter(client as GatewayClient))
            .map((client) => client.connId),
        ),
    };

    // Measure recipient selection on this handle; the preference worker has its own connection.
    const reads = trackSqliteStatementExecutions(
      openOpenClawStateDatabase().db,
      ["profiles"],
      (sql) =>
        /^select\b/i.test(sql) && /\bfrom "user_profiles"(?:\s|$)/i.test(sql) ? "profiles" : null,
    );
    try {
      expect(
        await invokePreferenceMethod(
          "users.prefs.set",
          { entries: { "ui.accent": "#A1B2C3", "ui.theme": null } },
          retired.id,
          context,
        ),
      ).toMatchObject({ ok: true, payload: { status: "ok" } });
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "users.prefs.changed",
        { profileId: owner.id, keys: ["ui.accent", "ui.theme"] },
        new Set(["owner", "merged"]),
      );
      expect(reads.rowCounts.profiles).toBeGreaterThan(0);
      expect.soft(reads.blobBytes.profiles).toBe(0);
    } finally {
      reads.restore();
    }
  } finally {
    await state.cleanup();
  }
});

test("users.prefs.set returns typed profile quota details", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-quota-",
  });
  try {
    const profile = ensureProfileForEmail("quota@example.test");
    for (let start = 0; start < 128; start += 32) {
      const entries = Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`key-${start + index}`, true]),
      );
      expect(
        await invokePreferenceMethod("users.prefs.set", { entries }, profile.id),
      ).toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
    }

    expect(
      await invokePreferenceMethod("users.prefs.set", { entries: { "key-128": true } }, profile.id),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: {
          code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
          limit: 128,
          currentCount: 128,
        },
      },
    });
  } finally {
    await state.cleanup();
  }
});

test("users.prefs.set compares canonical preferences atomically and publishes only committed writes", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-conditional-",
  });
  try {
    const retired = ensureProfileForEmail("conditional-retired@example.test");
    const owner = ensureProfileForEmail("conditional-owner@example.test");
    const original = {
      selection: { folder: "/new", model: "new", nested: [1, { a: 2, b: 3 }] },
      removed: true,
    };
    expect(
      await invokePreferenceMethod("users.prefs.set", { entries: original }, owner.id),
    ).toMatchObject({
      ok: true,
      payload: { status: "ok" },
    });
    linkEmail("conditional-retired@example.test", owner.id);
    const context = {
      broadcastToConnIds: vi.fn(),
      getClientConnIds: vi.fn(() => new Set(["owner"])),
    };
    for (const entries of [{ removed: null, inserted: true }, {}]) {
      expect(
        await invokePreferenceMethod(
          "users.prefs.set",
          {
            entries,
            expectedEntries: { selection: { folder: "/old" } },
          },
          retired.id,
          context,
        ),
      ).toEqual({ ok: true, payload: { status: "conflict" }, error: undefined });
    }
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(context.getClientConnIds).not.toHaveBeenCalled();
    expect(await invokePreferenceMethod("users.prefs.get", {}, owner.id)).toMatchObject({
      payload: { status: "ok", entries: original },
    });
    expect(
      await invokePreferenceMethod(
        "users.prefs.set",
        {
          entries: { removed: null, inserted: true },
          expectedEntries: {
            selection: { nested: [1, { b: 3, a: 2 }], model: "new", folder: "/new" },
            inserted: null,
          },
        },
        retired.id,
        context,
      ),
    ).toEqual({ ok: true, payload: { status: "ok" }, error: undefined });
    expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "users.prefs.changed",
      { profileId: owner.id, keys: ["removed", "inserted"] },
      new Set(["owner"]),
    );
    expect(await invokePreferenceMethod("users.prefs.get", {}, owner.id)).toMatchObject({
      payload: { status: "ok", entries: { selection: original.selection, inserted: true } },
    });
  } finally {
    await state.cleanup();
  }
});
