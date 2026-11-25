import { afterEach, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import * as ownership from "../../agents/harness/session-runtime-ownership.js";
import { authorizationClient } from "../server-methods.authorization.test-support.js";
import * as prepared from "../server-model-catalog-auth.js";
import * as sharing from "../session-sharing-authorization-async.js";
import * as metadata from "./chat-metadata-handler.js";
import { modelsAuthStatusHandlers } from "./models-auth-status.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
  withModelsListState,
} from "./models-list-result.openai-routes.test-support.js";
import type { RespondFn } from "./types.js";

const personal =
  "personal:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002";
const provider = "fixture";
const target = {
  sessionKey: "agent:work:my-session",
  provider,
  model: "chat",
  runtime: "openclaw",
};
const shared = {
  type: "api_key" as const,
  provider,
  key: "synthetic-only",
  displayName: "Not public",
};
function fixture() {
  vi.spyOn(sharing, "resolveSessionMutationAuthorizationAsync").mockResolvedValue({ error: null });
  const release = vi.fn();
  const scope = {
    agentId: "work",
    sessionKey: target.sessionKey,
    sessionEntry: { sessionId: "fixture-session" },
    release,
  };
  const resolve = vi.spyOn(metadata, "resolveChatMetadataReadParams").mockResolvedValue(scope);
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      "fixture:a": shared,
      "fixture:b": shared,
      "fixture:cooldown": shared,
      [personal]: shared,
      "other:a": { ...shared, provider: "other" },
    },
    order: { fixture: ["fixture:b", "fixture:cooldown", personal, "fixture:a"] },
    usageStats: { "fixture:cooldown": { cooldownUntil: Date.now() + 600_000 } },
  };
  const context = createModelsListTestContext({
    agentId: "work",
    cfg: { agents: { entries: { work: {} }, defaults: { model: "fixture/chat" } } },
    catalog: [providerCatalogEntry(provider, "chat")],
    preparedAuthStore: store,
    catalogComplete: true,
  });
  context.readPreparedModelsList = vi.fn(async () => ({
    models: [{ provider, id: "chat", name: "Chat", available: true, manualSelectionAllowed: true }],
  }));
  const read = vi.spyOn(prepared, "readPreparedCatalog");
  const request = async (accountTarget = target, scopes = ["operator.write"]) => {
    const respond = vi.fn<RespondFn>();
    const method = "models.authStatus";
    const params = { accountTarget };
    await modelsAuthStatusHandlers[method]!({
      req: { type: "req", id: "target", method, params },
      params,
      context,
      client: authorizationClient("test", scopes),
      isWebchatConnect: () => false,
      respond,
    });
    const [ok, result, err] = respond.mock.calls[0]!;
    expect(ok, JSON.stringify(err)).toBe(true);
    return result;
  };
  return { scope, resolve, context, request, read, release, store };
}
afterEach(() => vi.restoreAllMocks());
it("returns only the exact usable shared pins in the saved session agent's order", () =>
  withModelsListState(async () => {
    const f = fixture();
    const result = await f.request();
    expect(result).toMatchObject({
      accountTarget: {
        provider,
        model: "chat",
        runtime: "openclaw",
        accounts: [
          { profileId: "fixture:b", ordinal: 2 },
          { profileId: "fixture:a", ordinal: 1 },
        ],
      },
    });
    expect(f.read).toHaveBeenCalledWith(f.context, "work");
    expect(f.resolve).toHaveBeenCalledWith(expect.anything(), {
      sessionKey: target.sessionKey,
      agentId: undefined,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /my-session|Not public|personal:|other:a|synthetic-only|fixture:cooldown/,
    );
    expect(f.release).toHaveBeenCalledOnce();
  }));
it("withholds unknown routes, native and worker ownership, and a different agent's prepared store", () =>
  withModelsListState(async () => {
    const f = fixture();
    const empty = { providers: [], accountTarget: { accounts: [] } };
    expect(await f.request(target, ["operator.read"])).toMatchObject(empty);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(await f.request({ ...target, model: "not-listed" })).toMatchObject(empty);
    expect(await f.request({ ...target, runtime: "unknown" })).toMatchObject(empty);
    f.resolve.mockResolvedValueOnce({ ...f.scope, workerInference: "worker" });
    expect(await f.request()).toMatchObject(empty);
    vi.spyOn(ownership, "readSessionRuntimeOwnershipAsync").mockResolvedValueOnce({
      model: "native",
      auth: "native",
    });
    expect(await f.request()).toMatchObject(empty);
    const snapshot = await prepared.readPreparedCatalog(f.context, "work");
    f.read.mockResolvedValueOnce({ ...snapshot!, agentId: "elsewhere" });
    expect(await f.request()).toMatchObject(empty);
    expect(f.release).toHaveBeenCalledTimes(5);
  }));

it("honors prepared per-account rejection without running discovery or using a fallback pin", () =>
  withModelsListState(async () => {
    const f = fixture();
    const snapshot = await prepared.readPreparedCatalog(f.context, "work");
    if (!snapshot) {
      throw new Error("missing prepared fixture");
    }
    const acquire = vi.fn<NonNullable<typeof snapshot.accountCatalog>["acquire"]>(
      async ({ profileId, allowDiscovery }) => {
        expect(allowDiscovery).toBe(false);
        return {
          isCurrent: () => true,
          hasPublishedCatalog: profileId === "fixture:b",
          outcomes:
            profileId === "fixture:b" ? [{ provider, profileId, status: "auth-rejected" }] : [],
        };
      },
    );
    f.read.mockResolvedValue({
      ...snapshot,
      accountCatalog: {
        acquire,
        reconcileAuth: vi.fn(),
        readServiceTierObservations: () => [],
        prepareServiceTierObserver: () => () => false,
      },
    });
    expect(await f.request()).toMatchObject({
      accountTarget: { accounts: [{ profileId: "fixture:a", ordinal: 1 }] },
    });
    expect(acquire.mock.calls.every(([{ profileId }]) => profileId.startsWith("fixture:"))).toBe(
      true,
    );
  }));

it("refuses a conflicting session and agent before reading the credential owner", () =>
  withModelsListState(async () => {
    const f = fixture();
    f.resolve.mockRestore();
    const respond = vi.fn<RespondFn>();
    const method = "models.authStatus";
    const params = {
      agentId: "work",
      accountTarget: { ...target, sessionKey: "agent:other:elsewhere" },
    };
    await modelsAuthStatusHandlers[method]!({
      req: { type: "req", id: "agent-mismatch", method, params },
      params,
      context: f.context,
      client: authorizationClient("test", ["operator.write"]),
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("does not match"),
      }),
    );
    expect(f.read).not.toHaveBeenCalled();
  }));
