import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as facadeRuntime from "../plugin-sdk/facade-runtime.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

const { resolveSessionKeyFromResolveParams: resolveWithClient } =
  await import("./sessions-resolve.js");

type ResolveParams = Parameters<typeof resolveWithClient>[0];
type Fixture = Parameters<typeof createSessionRowProjectionFixture>[0];
const session = (sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId,
  updatedAt: 1,
  ...fields,
});
const resolved = (key: string, fields = {}) => ({ ok: true, key, agentId: "main", ...fields });
let selectedStore: Omit<Fixture, "cfg">;
let projections: ReturnType<typeof createSessionRowProjectionFixture>[];
const resolve = (p: ResolveParams["p"], cfg: OpenClawConfig = {}) => {
  setRuntimeConfigSnapshot(cfg);
  const projection = createSessionRowProjectionFixture({
    ...selectedStore,
    cfg,
    agentId: p.agentId ?? "main",
  });
  projections.push(projection);
  return resolveWithClient({ client: null, p, projection });
};

describe("resolveSessionKeyFromResolveParams", () => {
  const storePath = "sessions-resolve";

  function setStore(store: Record<string, SessionEntry>, owners?: Record<string, string>) {
    selectedStore = {
      store,
      storePath,
      targetsBySessionKey:
        owners &&
        new Map(
          Object.entries(owners).map(([key, agentId]) => [
            key,
            {
              agentId,
              storeTarget: { agentId, storePath },
              entry: store[key],
              readSourceEntry: (parentKey: string) => store[parentKey],
              resolveSourceKey: (parentKey: string) => parentKey,
            },
          ]),
        ),
    };
  }

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    setStore({});
    projections = [];
    onTestFinished(() => {
      for (const projection of projections) {
        projection.dispose();
      }
      clearRuntimeConfigSnapshot();
    });
  });

  it("ignores a deleted-agent short-id collision before resolving a unique match", () => {
    const survivingKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
    const deletedKey = "agent:deleted-agent:thread:12345678-0bbb-4000-8000-000000000002";
    setStore({
      [deletedKey]: session(deletedKey, { updatedAt: 2, displayName: "Deleted session" }),
      [survivingKey]: session(survivingKey, {
        archivedAt: 20,
        displayName: "Original session",
        label: "Surviving session",
        boardFace: "dashboard",
        boardPresentation: "expanded",
      }),
    });

    expect(resolve({ shortId: "12345678", slugHint: "deleted-session" })).toEqual(
      resolved(survivingKey, {
        displayName: "Surviving session",
        boardFace: "dashboard",
        boardPresentation: "expanded",
      }),
    );
  });

  it("resolves a shared title to the remaining agent's session", () => {
    const liveKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
    const retiredKey = "agent:retired:thread:12345678-0bbb-4000-8000-000000000002";
    const displayName = "Shared dashboard";
    setStore(
      {
        [liveKey]: session(liveKey, { displayName }),
        [retiredKey]: session(retiredKey, { displayName, updatedAt: 2 }),
      },
      { [liveKey]: "main", [retiredKey]: "main" },
    );

    const query = { reference: { key: "agent:main:missing", slug: "shared-dashboard" } };
    expect(resolve(query, { agents: { entries: { main: {}, retired: {} } } })).toMatchObject({
      ambiguous: true,
    });
    expect(resolve(query)).toEqual(resolved(liveKey, { displayName }));
  });

  it("applies agent scoping to short-id matches", () => {
    const mainKey = "agent:main:thread:feedface-0000-4000-8000-000000000001";
    const workKey = "agent:work:thread:feedface-0000-4000-8000-000000000002";
    setStore({
      [mainKey]: session(mainKey),
      [workKey]: session(workKey, { updatedAt: 2 }),
    });

    expect(
      resolve(
        { shortId: "feedface", agentId: "main" },
        { agents: { entries: { main: {}, work: {} } } },
      ),
    ).toEqual(resolved(mainKey));
  });

  it("resolves a configured global alias with its stored non-default owner", () => {
    setStore(
      {
        global: session("work-global", { displayName: "Work dashboard", boardFace: "dashboard" }),
      },
      { global: "work" },
    );
    expect(
      resolve(
        { reference: { key: "agent:work:primary" }, agentId: "work", includeGlobal: true },
        {
          agents: { entries: { main: {}, work: {} } },
          session: { scope: "global", mainKey: "primary" },
        },
      ),
    ).toEqual({
      ok: true,
      key: "global",
      agentId: "work",
      displayName: "Work dashboard",
      boardFace: "dashboard",
    });
  });

  it.each(["!Room:example.org", "!room:example.org"])(
    "preserves opaque reference key casing: %s",
    (room) => {
      const bundledFallback = vi
        .spyOn(facadeRuntime, "tryLoadActivatedBundledPluginPublicSurfaceModuleSync")
        .mockReturnValue(null);
      onTestFinished(() => bundledFallback.mockRestore());
      const key = "agent:main:matrix:channel:!Room:example.org";
      setStore({ [key]: session(key, { displayName: "Room" }) }, { [key]: "main" });
      const result = resolve({
        reference: { key: `agent:main:matrix:channel:${room}` },
        agentId: "main",
        allowMissing: true,
      });
      expect(result).toEqual(
        room.startsWith("!Room")
          ? resolved(key, { displayName: "Room" })
          : { ok: true, missing: true },
      );
      expect(bundledFallback).not.toHaveBeenCalled();
    },
  );
});
