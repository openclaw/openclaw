import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

const hoisted = vi.hoisted(() => ({
  listAgentIdsMock: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
    "../agents/agent-scope.js",
  );
  return {
    ...actual,
    listAgentIds: hoisted.listAgentIdsMock,
  };
});

const { resolveSessionKeyFromResolveParams: resolveSessionKeyFromResolveParamsWithClient } =
  await import("./sessions-resolve.js");

type ResolveParams = Parameters<typeof resolveSessionKeyFromResolveParamsWithClient>[0];

let selectedStore:
  | {
      store: Record<string, SessionEntry>;
      storePath?: string;
      targetsBySessionKey?: Map<
        string,
        { agentId: string; storeTarget: { agentId: string; storePath: string } }
      >;
    }
  | undefined;
let projections: ReturnType<typeof createSessionRowProjectionFixture>[];
const resolve = (p: ResolveParams["p"], cfg: OpenClawConfig = {}) => {
  setRuntimeConfigSnapshot(cfg);
  const store = selectedStore?.store ?? {};
  const projection = createSessionRowProjectionFixture({
    cfg,
    store,
    storePath: selectedStore?.storePath,
    agentId: p.agentId ?? "main",
    targetsBySessionKey:
      selectedStore?.targetsBySessionKey &&
      new Map(
        [...selectedStore.targetsBySessionKey].map(([key, target]) => [
          key,
          {
            ...target,
            entry: store[key],
            readSourceEntry: (parentKey: string) => store[parentKey],
            resolveSourceKey: (parentKey: string) => parentKey,
          },
        ]),
      ),
  });
  projections.push(projection);
  return resolveSessionKeyFromResolveParamsWithClient({
    client: null,
    p,
    projection,
  });
};

describe("resolveSessionKeyFromResolveParams", () => {
  const target = (key: string) =>
    [key, { agentId: "main", storeTarget: { agentId: "main", storePath } }] as const;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;

  function setStore(
    store: Record<string, SessionEntry>,
    targetsBySessionKey?: NonNullable<typeof selectedStore>["targetsBySessionKey"],
  ) {
    selectedStore = { store, storePath, targetsBySessionKey };
  }

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    storePath = path.join(tempDirs.make("sessions-resolve-"), "sessions.json");
    selectedStore = undefined;
    projections = [];
    onTestFinished(() => {
      for (const projection of projections) {
        projection.dispose();
      }
      clearRuntimeConfigSnapshot();
    });
    hoisted.listAgentIdsMock.mockReset();
    // Default: all agents are known (main is always present).
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);
  });

  it("uses a display-name slug only to narrow a short-id tie", () => {
    const releaseKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
    const deployKey = "agent:main:thread:12345678-0bbb-4000-8000-000000000002";
    setStore({
      [releaseKey]: { sessionId: releaseKey, updatedAt: 2, displayName: "Release monitor" },
      [deployKey]: {
        sessionId: deployKey,
        updatedAt: 1,
        displayName: "Deploy monitor",
        boardFace: "chat",
      },
    });

    expect(resolve({ shortId: "12345678", slugHint: "deploy-monitor" })).toEqual({
      ok: true,
      key: deployKey,
      agentId: "main",
      displayName: "Deploy monitor",
      boardFace: "chat",
    });
  });

  it("ignores a deleted-agent short-id collision before resolving a unique match", () => {
    const survivingKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
    const deletedKey = "agent:deleted-agent:thread:12345678-0bbb-4000-8000-000000000002";
    setStore({
      [deletedKey]: { sessionId: deletedKey, updatedAt: 2, displayName: "Deleted session" },
      [survivingKey]: {
        sessionId: survivingKey,
        updatedAt: 1,
        archivedAt: 20,
        displayName: "Original session",
        label: "Surviving session",
        boardFace: "dashboard",
        boardPresentation: "expanded",
      },
    });

    expect(resolve({ shortId: "12345678", slugHint: "deleted-session" })).toEqual({
      ok: true,
      key: survivingKey,
      agentId: "main",
      displayName: "Surviving session",
      boardFace: "dashboard",
      boardPresentation: "expanded",
    });
  });

  it("returns at most ten recent candidates and ignores a stale slug hint", () => {
    const store = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const suffix = index.toString(16).padStart(4, "0");
        return [
          `agent:main:thread:12345678-${suffix}-4000-8000-000000000000`,
          {
            sessionId: `candidate-${index}`,
            updatedAt: 100 - index,
            displayName: `Candidate ${index}`,
            ...(index % 2 === 0 ? { boardFace: "dashboard" as const } : {}),
          },
        ];
      }),
    );
    setStore(store);

    const expectedKeys = Object.keys(store).slice(0, 10);
    expect(resolve({ shortId: "12345678", slugHint: "renamed-session" })).toEqual({
      ok: true,
      ambiguous: true,
      candidates: expectedKeys.map((key, index) => {
        const candidate: {
          key: string;
          agentId: string;
          displayName: string;
          boardFace?: "dashboard";
        } = { key, agentId: "main", displayName: `Candidate ${index}` };
        if (index % 2 === 0) {
          candidate.boardFace = "dashboard";
        }
        return candidate;
      }),
    });
  });

  it("applies agent scoping to short-id matches", () => {
    const mainKey = "agent:main:thread:feedface-0000-4000-8000-000000000001";
    const workKey = "agent:work:thread:feedface-0000-4000-8000-000000000002";
    setStore({
      [mainKey]: { sessionId: mainKey, updatedAt: 1 },
      [workKey]: { sessionId: workKey, updatedAt: 2 },
    });

    expect(
      resolve(
        { shortId: "feedface", agentId: "main" },
        { agents: { entries: { main: {}, work: {} } } },
      ),
    ).toEqual({ ok: true, key: mainKey, agentId: "main" });
  });

  it("supports allowMissing for short ids", () => {
    setStore({});

    expect(resolve({ shortId: "deadbeef", allowMissing: true })).toEqual({
      ok: true,
      missing: true,
    });
  });

  it("resolves a configured global alias with its stored non-default owner", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["main", "work"]);
    setStore(
      {
        global: {
          sessionId: "work-global",
          updatedAt: 1,
          displayName: "Work dashboard",
          boardFace: "dashboard",
        },
      },
      new Map([["global", { agentId: "work", storeTarget: { agentId: "work", storePath } }]]),
    );
    expect(
      resolve(
        { reference: { key: "agent:work:primary" }, agentId: "work", includeGlobal: true },
        { session: { scope: "global", mainKey: "primary" } },
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
      setStore(
        { [key]: { sessionId: key, updatedAt: 1, displayName: "Room" } },
        new Map([target(key)]),
      );
      const result = resolve({
        reference: { key: `agent:main:matrix:channel:${room}` },
        agentId: "main",
        allowMissing: true,
      });
      expect(result).toEqual(
        room.startsWith("!Room")
          ? { ok: true, key, agentId: "main", displayName: "Room" }
          : { ok: true, missing: true },
      );
      expect(bundledFallback).not.toHaveBeenCalled();
    },
  );

  it("bounds named-reference ambiguity after excluding deleted agents and non-UUID titles", () => {
    const store = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `agent:main:thread:12345678-${index.toString(16).padStart(4, "0")}-4000-8000-000000000000`,
        {
          sessionId: `candidate-${index}`,
          updatedAt: 100 - index,
          displayName: "Shared dashboard",
          boardFace: "dashboard" as const,
        },
      ]),
    );
    const keys = Object.keys(store);
    store["agent:deleted:thread:12345678-ffff-4000-8000-000000000000"] = {
      sessionId: "deleted-dashboard",
      updatedAt: 200,
      displayName: "Shared dashboard",
      boardFace: "dashboard",
    };
    store["agent:main:literal"] = {
      sessionId: "literal-dashboard",
      updatedAt: 300,
      displayName: "Shared dashboard",
      boardFace: "dashboard",
    };
    setStore(store, new Map(Object.keys(store).map(target)));
    expect(resolve({ reference: { key: "agent:main:missing", slug: "shared-dashboard" } })).toEqual(
      {
        ok: true,
        ambiguous: true,
        candidates: keys.slice(0, 10).map((key) => ({
          key,
          agentId: "main",
          displayName: "Shared dashboard",
          boardFace: "dashboard",
        })),
      },
    );
  });

  it.each([
    {
      p: { shortId: "too-short" },
      message: "shortId must be 8-32 hexadecimal characters",
    },
    { p: { label: "release", slugHint: "release" }, message: "slugHint requires shortId" },
    {
      p: { key: "agent:main:literal", reference: { key: "agent:main:literal" } },
      message: "Provide either key, sessionId, label, shortId, or reference (not multiple)",
    },
  ])("rejects invalid short reference params: $message", ({ p, message }) => {
    expect(resolve(p)).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message },
    });
  });
});
