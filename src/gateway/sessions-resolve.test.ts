// Session resolve tests cover agent scoping, selector precedence, and protocol errors.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

let targetStore: Record<string, SessionEntry>;
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
let projections: Map<OpenClawConfig, ReturnType<typeof createSessionRowProjectionFixture>>;
const setFixtureStore = (store: NonNullable<typeof selectedStore>) => {
  selectedStore = store;
};
const resolveSessionKeyFromResolveParams = (
  params: Omit<ResolveParams, "client" | "projection"> & {
    cfg: OpenClawConfig;
    client?: ResolveParams["client"];
  },
) => {
  let projection = projections.get(params.cfg);
  if (!projection) {
    const store = selectedStore?.store ?? targetStore;
    projection = createSessionRowProjectionFixture({
      cfg: params.cfg,
      store,
      storePath: selectedStore?.storePath,
      agentId: params.p.agentId ?? "main",
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
    projections.set(params.cfg, projection);
    const created = projection;
    onTestFinished(() => created.dispose());
  }
  return resolveSessionKeyFromResolveParamsWithClient({
    client: params.client ?? null,
    p: params.p,
    projection,
  });
};

describe("resolveSessionKeyFromResolveParams", () => {
  const canonicalKey = "agent:main:canon";
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    storePath = path.join(tempDirs.make("sessions-resolve-"), "sessions.json");
    selectedStore = undefined;
    projections = new Map();
    hoisted.listAgentIdsMock.mockReset();
    targetStore = {};
    // Default: all agents are known (main is always present).
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);
  });

  it("hides canonical keys that fail the spawnedBy visibility filter", () => {
    targetStore = {
      [canonicalKey]: { sessionId: "sess-1", updatedAt: 1 },
    };

    expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: `No session found: ${canonicalKey}`,
      },
    });
  });

  it("resolves archived short ids with display metadata", () => {
    const key = "agent:main:thread:abcdef12-3456-4789-8abc-def012345678";
    setFixtureStore({
      storePath,
      store: {
        [key]: {
          sessionId: "sess-short",
          updatedAt: 10,
          archivedAt: 20,
          displayName: "Release monitor",
          label: "Renamed release monitor",
          boardFace: "dashboard",
          boardPresentation: "expanded",
        },
      },
    });

    expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "ABCDEF12", agentId: "main" },
      }),
    ).toEqual({
      ok: true,
      key,
      agentId: "main",
      displayName: "Renamed release monitor",
      boardFace: "dashboard",
      boardPresentation: "expanded",
    });
  });

  it("uses a display-name slug only to narrow a short-id tie", () => {
    const releaseKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
    const deployKey = "agent:main:thread:12345678-0bbb-4000-8000-000000000002";
    setFixtureStore({
      storePath,
      store: {
        [releaseKey]: { sessionId: releaseKey, updatedAt: 2, displayName: "Release monitor" },
        [deployKey]: {
          sessionId: deployKey,
          updatedAt: 1,
          displayName: "Deploy monitor",
          boardFace: "chat",
        },
      },
    });

    expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "12345678", slugHint: "deploy-monitor" },
      }),
    ).toEqual({
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
    setFixtureStore({
      storePath,
      store: {
        [deletedKey]: { sessionId: deletedKey, updatedAt: 2, displayName: "Deleted session" },
        [survivingKey]: { sessionId: survivingKey, updatedAt: 1, displayName: "Surviving session" },
      },
    });

    expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "12345678", slugHint: "deleted-session" },
      }),
    ).toEqual({
      ok: true,
      key: survivingKey,
      agentId: "main",
      displayName: "Surviving session",
    });
  });

  it("reports a deleted-agent-only short-id match as missing", () => {
    const deletedKey = "agent:deleted-agent:thread:12345678-0bbb-4000-8000-000000000002";
    setFixtureStore({
      storePath,
      store: {
        [deletedKey]: { sessionId: deletedKey, updatedAt: 1, displayName: "Deleted session" },
      },
    });

    expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "12345678" },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: "No session found: 12345678",
      },
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
    setFixtureStore({ storePath, store });

    const expectedKeys = Object.keys(store).slice(0, 10);
    expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "12345678", slugHint: "renamed-session" },
      }),
    ).toEqual({
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
    setFixtureStore({
      storePath,
      store: {
        [mainKey]: { sessionId: mainKey, updatedAt: 1 },
        [workKey]: { sessionId: workKey, updatedAt: 2 },
      },
    });

    expect(
      resolveSessionKeyFromResolveParams({
        cfg: { agents: { entries: { main: {}, work: {} } } },
        p: { shortId: "feedface", agentId: "main" },
      }),
    ).toEqual({ ok: true, key: mainKey, agentId: "main" });
  });

  it("supports allowMissing for short ids", () => {
    setFixtureStore({ storePath, store: {} });

    expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "deadbeef", allowMissing: true },
      }),
    ).toEqual({ ok: true, missing: true });
  });

  it.each([
    { key: "agent:main:deploy-monitor", slug: "deploy-monitor", expected: "literal" },
    { key: "agent:main:missing", slug: "deploy-monitor", expected: "slug" },
    { key: "agent:main:missing", expected: "missing" },
  ])("discovers a named reference with exact-key precedence: $expected", (reference) => {
    const literal = "agent:main:deploy-monitor";
    const slugKey = "agent:main:thread:12345678-0000-4000-8000-000000000001";
    const store = {
      [literal]: {
        sessionId: literal,
        updatedAt: 1,
        displayName: "Literal session",
        boardFace: "chat" as const,
      },
      [slugKey]: {
        sessionId: slugKey,
        updatedAt: 2,
        displayName: "Deploy: monitor",
        boardFace: "dashboard" as const,
      },
    };
    setFixtureStore({
      storePath,
      store,
      targetsBySessionKey: new Map(
        Object.keys(store).map((key) => [
          key,
          { agentId: "main", storeTarget: { agentId: "main", storePath } },
        ]),
      ),
    });
    const result = resolveSessionKeyFromResolveParams({
      cfg: {},
      p: {
        reference: { key: reference.key, slug: reference.slug },
        agentId: "main",
        allowMissing: true,
      },
    });
    expect(result).toEqual(
      reference.expected === "missing"
        ? { ok: true, missing: true }
        : {
            ok: true,
            key: reference.expected === "literal" ? literal : slugKey,
            agentId: "main",
            displayName: reference.expected === "literal" ? "Literal session" : "Deploy: monitor",
            boardFace: reference.expected === "literal" ? "chat" : "dashboard",
          },
    );
  });

  it("resolves a configured global alias with its stored non-default owner", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["main", "work"]);
    setFixtureStore({
      storePath,
      store: {
        global: {
          sessionId: "work-global",
          updatedAt: 1,
          displayName: "Work dashboard",
          boardFace: "dashboard",
        },
      },
      targetsBySessionKey: new Map([
        ["global", { agentId: "work", storeTarget: { agentId: "work", storePath } }],
      ]),
    });
    expect(
      resolveSessionKeyFromResolveParams({
        cfg: { session: { scope: "global", mainKey: "primary" } },
        p: { reference: { key: "agent:work:primary" }, agentId: "work", includeGlobal: true },
      }),
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
      setFixtureStore({
        storePath,
        store: { [key]: { sessionId: key, updatedAt: 1, displayName: "Room" } },
        targetsBySessionKey: new Map([
          [key, { agentId: "main", storeTarget: { agentId: "main", storePath } }],
        ]),
      });
      const result = resolveSessionKeyFromResolveParams({
        cfg: {},
        p: {
          reference: { key: `agent:main:matrix:channel:${room}` },
          agentId: "main",
          allowMissing: true,
        },
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
    setFixtureStore({
      storePath,
      store,
      targetsBySessionKey: new Map(
        Object.keys(store).map((key) => [
          key,
          { agentId: "main", storeTarget: { agentId: "main", storePath } },
        ]),
      ),
    });
    expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { reference: { key: "agent:main:missing", slug: "shared-dashboard" } },
      }),
    ).toEqual({
      ok: true,
      ambiguous: true,
      candidates: keys.slice(0, 10).map((key) => ({
        key,
        agentId: "main",
        displayName: "Shared dashboard",
        boardFace: "dashboard",
      })),
    });
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
    expect(resolveSessionKeyFromResolveParams({ cfg: {}, p })).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message },
    });
  });
});
