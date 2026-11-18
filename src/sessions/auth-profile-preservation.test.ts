import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import * as authStore from "../agents/auth-profiles/store.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applyModelOverrideWithAuthProfileCompatibility as applyOverride,
  shouldPreserveSessionAuthProfileOverride as shouldPreserve,
} from "./auth-profile-preservation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeAll(() => prepareSharedAuthStoreOwnership());
afterEach(() => vi.restoreAllMocks());

function profileConfig(provider: string, id = "team:prod"): OpenClawConfig {
  return { auth: { profiles: { [id]: { provider, mode: "api_key" } } } };
}

const entry = {
  sessionId: "session-auth-profile-preservation",
  updatedAt: 1,
  authProfileOverride: "fixture-provider:work",
} satisfies SessionEntry;

const defaults = { cfg: {}, agentDir: "/fixture/agent", entry, currentProvider: "openai" };
function preserves(overrides: Partial<Parameters<typeof shouldPreserve>[0]>) {
  return shouldPreserve({ ...defaults, provider: "openai", ...overrides });
}

it.each([
  { provider: "openai", configured: "anthropic", expected: true },
  { provider: "anthropic", configured: "openai", expected: false },
  { provider: undefined, configured: "openai", expected: true },
])(
  "consumes prepared provider $provider before config $configured without synchronous reads",
  ({ provider, configured, expected }) => {
    const unexpectedRead = () => {
      throw new Error("unprepared synchronous credential read");
    };
    for (const reader of [
      "findPersistedAuthProfileCredential",
      "getRuntimeAuthProfileStoreSnapshot",
    ] as const) {
      vi.spyOn(authStore, reader).mockImplementation(unexpectedRead);
    }
    const selectedEntry = { ...entry, authProfileOverride: "openai:missing" };
    const params = {
      ...defaults,
      cfg: profileConfig(configured, "openai:missing"),
      entry: selectedEntry,
      recordedProvider: { provider },
    };
    applyOverride({ ...params, selection: { provider: "openai", model: "selected-model" } });
    expect(selectedEntry.authProfileOverride).toBe(expected ? "openai:missing" : undefined);
  },
);
it.each([
  { credentialProvider: "arcee", expected: false },
  { credentialProvider: "openrouter", expected: true },
])(
  "checks a pin's stored $credentialProvider realm against the configured endpoint",
  ({ credentialProvider, expected }) => {
    const plugin = createPluginManifestRecordFixture({
      id: "arcee",
      origin: "bundled",
      providers: ["arcee"],
      providerAuthAliases: {
        arcee: { provider: "openrouter", baseUrls: ["https://openrouter.ai/api/v1"] },
      },
    });
    const actual = preserves({
      cfg: {
        models: {
          providers: { arcee: { baseUrl: "https://openrouter.ai/api/v1", models: [] } },
        },
        ...profileConfig(credentialProvider),
      },
      agentDir: tempDirs.make("openclaw-endpoint-profile-pin-"),
      entry: { ...entry, authProfileOverride: "team:prod" },
      currentProvider: "arcee",
      provider: "arcee",
      metadataSnapshot: { plugins: [plugin] },
    });
    expect(actual).toBe(expected);
  },
);

it("uses a missing ordinary profile's provider prefix", () => {
  expect(preserves({ provider: "fixture-provider" })).toBe(true);
});

it("uses the recorded provider for an arbitrary stored profile id", () => {
  const agentDir = tempDirs.make("openclaw-auth-profile-preservation-");
  saveAuthProfileStore(
    {
      version: 1,
      profiles: { "team:prod": { type: "api_key", provider: "openai", key: "test" } },
    },
    agentDir,
  );

  const params = { agentDir, entry: { ...entry, authProfileOverride: "team:prod" } };
  expect(preserves(params)).toBe(true);
  expect(preserves({ ...params, provider: "anthropic" })).toBe(false);
});

it.each(["openai", "anthropic"])(
  "retains a missing personal pin only when the selected provider %s is compatible",
  async (provider) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      await prepareSharedAuthStoreOwnership(state.env);
      const personalId = `personal:${randomUUID()}:${randomUUID()}`;
      const sessionEntry: SessionEntry = {
        ...entry,
        authProfileOverride: personalId,
        authProfileOverrideSource: "user-link",
      };

      applyOverride({
        ...defaults,
        agentDir: state.agentDir(),
        entry: sessionEntry,
        selection: { provider, model: "another-model" },
      });

      expect([sessionEntry.authProfileOverride, sessionEntry.authProfileOverrideSource]).toEqual(
        provider === "openai" ? [personalId, "user-link"] : [undefined, undefined],
      );
    });
  },
);

it("clears an incompatible auth profile when resetting to a cross-provider default", () => {
  const sessionEntry = {
    ...entry,
    providerOverride: "openai",
    modelOverride: "gpt-4.1",
    modelOverrideSource: "user" as const,
    authProfileOverride: "team:prod",
    authProfileOverrideSource: "user" as const,
    authProfileOverrideCompactionCount: 2,
  };

  const result = applyOverride({
    ...defaults,
    cfg: profileConfig("openai"),
    agentDir: tempDirs.make("openclaw-auth-profile-default-"),
    entry: sessionEntry,
    selection: { provider: "anthropic", model: "claude-opus-4-6", isDefault: true },
  });

  expect(result.updated).toBe(true);
  expect(sessionEntry.providerOverride).toBeUndefined();
  expect(sessionEntry.modelOverride).toBeUndefined();
  expect(sessionEntry.modelOverrideSource).toBeUndefined();
  expect(sessionEntry.authProfileOverride).toBeUndefined();
  expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
  expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
});
