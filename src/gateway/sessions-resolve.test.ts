import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
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

  function candidates(display: (index: number) => Partial<SessionEntry>) {
    return Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `agent:main:thread:12345678-${index.toString(16).padStart(4, "0")}-4000-8000-000000000000`,
        { sessionId: `candidate-${index}`, updatedAt: 100 - index, ...display(index) },
      ]),
    );
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

  it("uses a display-name slug only to narrow a short-id tie", () => {
    const releaseKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
    const deployKey = "agent:main:thread:12345678-0bbb-4000-8000-000000000002";
    setStore({
      [releaseKey]: session(releaseKey, { updatedAt: 2, displayName: "Release monitor" }),
      [deployKey]: session(deployKey, { displayName: "Deploy monitor", boardFace: "chat" }),
    });

    expect(resolve({ shortId: "12345678", slugHint: "deploy-monitor" })).toEqual(
      resolved(deployKey, { displayName: "Deploy monitor", boardFace: "chat" }),
    );
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

  it("returns at most ten recent candidates and ignores a stale slug hint", () => {
    const store = candidates((index) => ({
      displayName: `Candidate ${index}`,
      ...(index % 2 === 0 ? { boardFace: "dashboard" as const } : {}),
    }));
    setStore(store);

    const expectedKeys = Object.keys(store).slice(0, 10);
    expect(resolve({ shortId: "12345678", slugHint: "renamed-session" })).toEqual({
      ok: true,
      ambiguous: true,
      candidates: expectedKeys.map((key, index) =>
        Object.assign(
          { key, agentId: "main", displayName: `Candidate ${index}` },
          index % 2 === 0 ? { boardFace: "dashboard" } : {},
        ),
      ),
    });
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

  it("supports allowMissing for short ids", () => {
    expect(resolve({ shortId: "deadbeef", allowMissing: true })).toEqual({
      ok: true,
      missing: true,
    });
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

  it("bounds named-reference ambiguity after excluding deleted agents and non-UUID titles", () => {
    const store = candidates(() => ({ displayName: "Shared dashboard", boardFace: "dashboard" }));
    const keys = Object.keys(store);
    const display = { displayName: "Shared dashboard", boardFace: "dashboard" as const };
    store["agent:deleted:thread:12345678-ffff-4000-8000-000000000000"] = session(
      "deleted-dashboard",
      { ...display, updatedAt: 200 },
    );
    store["agent:main:literal"] = session("literal-dashboard", {
      ...display,
      updatedAt: 300,
    });
    setStore(store, Object.fromEntries(Object.keys(store).map((key) => [key, "main"])));
    expect(resolve({ reference: { key: "agent:main:missing", slug: "shared-dashboard" } })).toEqual(
      {
        ok: true,
        ambiguous: true,
        candidates: keys
          .slice(0, 10)
          .map((key) => Object.assign({ key, agentId: "main" }, display)),
      },
    );
  });

  it.each([
    { p: { shortId: "too-short" }, message: "shortId must be 8-32 hexadecimal characters" },
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
