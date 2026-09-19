import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ThemeCatalogEntry } from "../../../packages/gateway-protocol/src/theme.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createThemeDefinitionFixture,
  createThemePaletteFixture,
} from "../../../test/helpers/theme-fixture.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as userPreferences from "../../state/user-preferences.js";
import { getUserPreferences, setUserPreferences } from "../../state/user-preferences.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { themeHandlers } from "./themes.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const { pluginThemes } = vi.hoisted(() => ({ pluginThemes: [] as ThemeCatalogEntry[] }));
vi.mock("../../plugins/theme-catalog.js", () => ({ listPluginThemes: () => pluginThemes }));

let state: OpenClawTestState;
let requesterProfileId: string;
let otherProfileId: string;

beforeEach(async () => {
  pluginThemes.length = 0;
  state = await createOpenClawTestState({ layout: "state-only", prefix: "themes-rpc-" });
  requesterProfileId = ensureProfileForEmail("requester@example.test").id;
  otherProfileId = ensureProfileForEmail("other@example.test").id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

function client(profileId?: string): GatewayClient {
  return {
    connId: "requester-browser",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.write"],
      client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, version: "test", platform: "test", mode: "ui" },
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

function runtimeIdentity(profileId?: string): AgentRuntimeIdentity {
  const operationalRunInstance = { instanceId: "theme-instance", runId: "theme-run" };
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:theme",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: "theme-generation",
      claimId: "theme-claim",
    },
    ...(profileId ? { gatewayUiCommandTarget: { connId: "closed-browser", profileId } } : {}),
  };
}

async function invoke(
  method: "themes.list" | "themes.get" | "themes.set" | "themes.import",
  params: Record<string, unknown> = {},
  options: Partial<Omit<GatewayRequestHandlerOptions, "context">> & {
    context?: Partial<GatewayRequestContext>;
  } = {},
) {
  const { context, ...requestOptions } = options;
  let result: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
  await themeHandlers[method]!({
    req: { type: "req", id: "theme-request", method, params },
    params,
    client: client(requesterProfileId),
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: { getRuntimeConfig: () => ({}), ...context },
    ...requestOptions,
  } as GatewayRequestHandlerOptions);
  return expectDefined(result, "theme RPC response");
}

function pluginTheme(): ThemeCatalogEntry {
  const definition = createThemeDefinitionFixture();
  return {
    id: "space-pack/xenovessel",
    name: definition.name,
    description: definition.description,
    source: "plugin",
    pluginId: "space-pack",
    modes: ["dark"],
    definition,
  };
}

function beforeWorkerCommit(checkpoint: () => void) {
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation((admit) =>
    createAdmission((request, grant) => {
      if (request.stage === "commit") {
        checkpoint();
      }
      admit(request, grant);
    }),
  );
}

function changePreferencesAfterSnapshot(entries: Record<string, unknown>) {
  const readPreferences = userPreferences.getCanonicalUserPreferences;
  vi.spyOn(userPreferences, "getCanonicalUserPreferences").mockImplementationOnce(
    async (...args) => {
      const snapshot = await readPreferences(...args);
      expect(
        await userPreferences.setCanonicalUserPreferences(requesterProfileId, entries),
      ).toMatchObject({ ok: true });
      return snapshot;
    },
  );
}

async function withConcurrentPreferenceSnapshots<T>(count: number, run: () => Promise<T>) {
  const readPreferences = userPreferences.getCanonicalUserPreferences;
  const release = createDeferred();
  let remaining = count;
  const read = vi
    .spyOn(userPreferences, "getCanonicalUserPreferences")
    .mockImplementation(async (...args) => {
      const snapshot = await readPreferences(...args);
      if (remaining > 0) {
        remaining -= 1;
        if (remaining === 0) {
          release.resolve();
        }
        await release.promise;
      }
      return snapshot;
    });
  try {
    return await run();
  } finally {
    release.resolve();
    read.mockRestore();
  }
}

describe("theme RPC", () => {
  it("lists descriptive choices and inspects a plugin definition without exposing palettes in list entries", async () => {
    pluginThemes.push(pluginTheme());
    const { definition, ...descriptor } = pluginTheme();
    const listed = await invoke("themes.list");
    expect(listed).toMatchObject({
      ok: true,
      payload: {
        current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
        themes: expect.arrayContaining([
          expect.objectContaining({ id: "claw", description: expect.stringMatching(/\S/) }),
          descriptor,
        ]),
      },
    });
    expect(await invoke("themes.get", { id: descriptor.id })).toMatchObject({
      ok: true,
      payload: { theme: descriptor, definition },
    });
  });

  it("imports and applies in one durable profile mutation, preserving other preferences and notifying only that profile", async () => {
    expect(
      setUserPreferences(requesterProfileId, { "ui.accent": "#aabbcc", "ui.fontFamily": "serif" })
        .ok,
    ).toBe(true);
    const requester = client(requesterProfileId);
    const other = { ...client(otherProfileId), connId: "other-browser" };
    const broadcastToConnIds = vi.fn();
    const definition = createThemeDefinitionFixture();
    expect(
      await invoke(
        "themes.import",
        { id: "xenovessel", definition, apply: true, mode: "dark" },
        {
          context: {
            broadcastToConnIds,
            getClientConnIds: (filter) =>
              new Set(
                [requester, other]
                  .filter((entry) => !filter || filter(entry))
                  .map((entry) => entry.connId!),
              ),
          },
        },
      ),
    ).toMatchObject({
      ok: true,
      payload: {
        current: { id: "user/xenovessel", mode: "dark", scope: "profile" },
        theme: { id: "user/xenovessel", source: "user" },
        definition,
        application: "saved",
      },
    });
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "users.prefs.changed",
      {
        profileId: requesterProfileId,
        keys: ["ui.themeDefinition.xenovessel", "ui.theme", "ui.themeMode"],
      },
      new Set(["requester-browser"]),
    );
    await closeOpenClawStateDatabaseAsync();
    expect(getUserPreferences(requesterProfileId)).toEqual({
      "ui.accent": "#aabbcc",
      "ui.fontFamily": "serif",
      "ui.themeDefinition.xenovessel": definition,
      "ui.theme": "user/xenovessel",
      "ui.themeMode": "dark",
    });
    expect(getUserPreferences(otherProfileId)).toEqual({});
  });

  it("rolls back the imported definition when selecting it fails in storage", async () => {
    expect(setUserPreferences(requesterProfileId, { "ui.theme": "claw" }).ok).toBe(true);
    expect((await invoke("themes.get")).ok).toBe(true);
    openOpenClawStateDatabase().db
      .exec(`CREATE TRIGGER refuse_theme_selection BEFORE INSERT ON user_preferences
      WHEN NEW.pref_key = 'ui.theme' BEGIN SELECT RAISE(ABORT, 'selection refused'); END`);
    expect(
      await invoke("themes.import", {
        id: "refused",
        definition: createThemeDefinitionFixture(),
        apply: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("selection refused") },
    });
    expect(getUserPreferences(requesterProfileId)).toEqual({ "ui.theme": "claw" });
  });

  it("validates and persists theme selection with accompanying appearance changes as one batch", async () => {
    pluginThemes.push(pluginTheme());
    const original = {
      "ui.theme": "claw",
      "ui.themeMode": "light",
      "ui.accent": "#aabbcc",
      "ui.fontUi": "geist",
      "ui.fontChat": "lora",
      "chat.showThinking": true,
    };
    expect(setUserPreferences(requesterProfileId, original).ok).toBe(true);
    const params = {
      id: "space-pack/xenovessel",
      appearance: { accent: "#A1B2C3", fontUi: "jetbrains-mono", fontChat: null },
    };
    expect(await invoke("themes.set", { ...params, mode: "light" })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("does not provide light mode") },
    });
    expect(getUserPreferences(requesterProfileId)).toEqual(original);

    expect(await invoke("themes.set", { ...params, mode: "dark" })).toMatchObject({
      ok: true,
      payload: { current: { id: params.id, mode: "dark" }, application: "saved" },
    });
    expect(getUserPreferences(requesterProfileId)).toEqual({
      "ui.theme": params.id,
      "ui.themeMode": "dark",
      "ui.accent": "#a1b2c3",
      "ui.fontUi": "jetbrains-mono",
      "chat.showThinking": true,
    });
  });

  it.each([
    { background: "url(https://example.test/collect)" },
    { background: "rgb(1 2 3 .5)" },
    { background: "oklch(50%, 0.2, 180)" },
    { "font-sans": "sans-serif; background: red" },
    { "font-sans": "'unterminated" },
  ])(
    "rejects unsafe or malformed theme values without importing or selecting: %j",
    async (palette) => {
      const definition = createThemeDefinitionFixture();
      definition.dark = { ...definition.dark!, ...palette };
      expect(
        await invoke("themes.import", { id: "unsafe", definition, apply: true }),
      ).toMatchObject({
        ok: false,
      });
      expect(getUserPreferences(requesterProfileId)).toEqual({});
    },
  );

  it("clears theme overrides against Gateway defaults while retaining saved custom themes", async () => {
    const definition = createThemeDefinitionFixture();
    expect(
      await invoke("themes.import", { id: "dark", definition, apply: true, mode: "dark" }),
    ).toMatchObject({ ok: true });
    expect(await invoke("themes.set", { id: null, mode: "light" })).toMatchObject({
      ok: true,
      payload: { current: { id: "claw", mode: "light", overrides: { mode: "light" } } },
    });
    expect(
      await invoke(
        "themes.set",
        { mode: null },
        { context: { getRuntimeConfig: () => ({ ui: { prefs: { themeMode: "dark" } } }) } },
      ),
    ).toMatchObject({
      ok: true,
      payload: { current: { id: "claw", mode: "dark", overrides: {} } },
    });
    expect(getUserPreferences(requesterProfileId)).toEqual({
      "ui.themeDefinition.dark": definition,
    });
  });

  it.each(["plugin", "import"])(
    "selects a dark-only %s theme in one call and refuses explicit incompatible modes without writes",
    async (source) => {
      pluginThemes.push(pluginTheme());
      const definition = createThemeDefinitionFixture();
      const original = { "ui.theme": "claw", "ui.themeMode": "light" };
      expect(setUserPreferences(requesterProfileId, original).ok).toBe(true);
      const method = source === "plugin" ? "themes.set" : "themes.import";
      const params =
        source === "plugin"
          ? { id: "space-pack/xenovessel" }
          : { id: "xenovessel", definition, apply: true };

      expect(await invoke(method, { ...params, mode: "light" })).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("does not provide light mode") },
      });
      expect(getUserPreferences(requesterProfileId)).toEqual(original);

      const selectedId = source === "plugin" ? "space-pack/xenovessel" : "user/xenovessel";
      expect(await invoke(method, params)).toMatchObject({
        ok: true,
        payload: { current: { id: selectedId, mode: "dark" }, application: "saved" },
      });
      const saved = {
        "ui.theme": selectedId,
        "ui.themeMode": "dark",
        ...(source === "import" ? { "ui.themeDefinition.xenovessel": definition } : {}),
      };
      expect(getUserPreferences(requesterProfileId)).toEqual(saved);

      for (const mode of ["light", null]) {
        expect(
          await invoke(
            "themes.set",
            { mode },
            {
              context: { getRuntimeConfig: () => ({ ui: { prefs: { themeMode: "light" } } }) },
            },
          ),
        ).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("does not provide light mode") },
        });
        expect(getUserPreferences(requesterProfileId)).toEqual(saved);
      }
    },
  );

  it.each([true, false])(
    "updates mode only when replacing the selected custom theme (selected=%s)",
    async (selected) => {
      const unrelated = { "ui.accent": "#aabbcc", "ui.fontFamily": "serif" };
      expect(
        setUserPreferences(requesterProfileId, {
          ...unrelated,
          "ui.theme": "claw",
          "ui.themeMode": "dark",
        }).ok,
      ).toBe(true);
      expect(
        await invoke("themes.import", {
          id: "adaptive",
          definition: createThemeDefinitionFixture(),
          apply: selected,
        }),
      ).toMatchObject({ ok: true });

      const replacement = {
        name: "Solar Vessel",
        description: "Pale surfaces with dark text and cyan accents",
        light: createThemePaletteFixture({ background: "#eeeeff", foreground: "#101020" }),
      };
      const id = selected ? "user/adaptive" : "claw";
      const mode = selected ? "light" : "dark";
      expect(
        await invoke("themes.import", { id: "adaptive", definition: replacement }),
      ).toMatchObject({
        ok: true,
        payload: { current: { id, mode }, definition: replacement, application: "saved" },
      });
      expect(getUserPreferences(requesterProfileId)).toEqual({
        ...unrelated,
        "ui.theme": id,
        "ui.themeMode": mode,
        "ui.themeDefinition.adaptive": replacement,
      });
    },
  );

  it("does not change another client's new selection when reimporting a previously selected theme", async () => {
    const original = createThemeDefinitionFixture();
    expect(
      await invoke("themes.import", {
        id: "adaptive",
        definition: original,
        apply: true,
        mode: "dark",
      }),
    ).toMatchObject({ ok: true });
    changePreferencesAfterSnapshot({ "ui.theme": "claw", "ui.themeMode": "dark" });
    const replacement = {
      name: "Daylight",
      description: "Light-only replacement",
      light: createThemePaletteFixture(),
    };
    expect(
      await invoke("themes.import", { id: "adaptive", definition: replacement }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(getUserPreferences(requesterProfileId)).toEqual({
      "ui.theme": "claw",
      "ui.themeMode": "dark",
      "ui.themeDefinition.adaptive": original,
    });
  });

  it("refuses a personal theme selection when another client replaces its prepared palette", async () => {
    expect(
      await invoke("themes.import", {
        id: "adaptive",
        definition: createThemeDefinitionFixture(),
      }),
    ).toMatchObject({ ok: true });
    const replacement = {
      name: "Daylight",
      description: "Light-only replacement",
      light: createThemePaletteFixture(),
    };
    changePreferencesAfterSnapshot({ "ui.themeDefinition.adaptive": replacement });
    expect(await invoke("themes.set", { id: "user/adaptive", mode: "dark" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(getUserPreferences(requesterProfileId)).toEqual({
      "ui.themeDefinition.adaptive": replacement,
    });
  });

  it("preserves an unrelated concurrent preference while committing a prepared theme selection", async () => {
    pluginThemes.push(pluginTheme());
    changePreferencesAfterSnapshot({ "chat.showThinking": true });
    expect(await invoke("themes.set", { id: "space-pack/xenovessel", mode: "dark" })).toMatchObject(
      {
        ok: true,
        payload: { current: { id: "space-pack/xenovessel", mode: "dark" }, application: "saved" },
      },
    );
    expect(getUserPreferences(requesterProfileId)).toEqual({
      "chat.showThinking": true,
      "ui.theme": "space-pack/xenovessel",
      "ui.themeMode": "dark",
    });
  });

  it("preserves independent concurrent imports and atomically settles competing selections", async () => {
    const expected: Record<string, unknown> = { "chat.showThinking": true };
    expect(setUserPreferences(requesterProfileId, expected).ok).toBe(true);
    for (let round = 0; round < 4; round += 1) {
      Object.assign(expected, { "ui.theme": "claw", "ui.themeMode": "system" });
      expect(
        setUserPreferences(requesterProfileId, { "ui.theme": "claw", "ui.themeMode": "system" }).ok,
      ).toBe(true);
      const ids = Array.from({ length: 4 }, (_, index) => `independent-${round}-${index}`);
      const definitions = ids.map((name) => createThemeDefinitionFixture({ name }));
      const imports = await withConcurrentPreferenceSnapshots(ids.length, () =>
        Promise.all(
          ids.map((id, index) => invoke("themes.import", { id, definition: definitions[index] })),
        ),
      );
      for (const [index, result] of imports.entries()) {
        expect(result).toMatchObject({ ok: true, payload: { application: "saved" } });
        expected[`ui.themeDefinition.${ids[index]}`] = definitions[index];
      }
      expect(getUserPreferences(requesterProfileId)).toEqual(expected);

      const choices = [
        ...[0, 1].map((index) => ({
          method: "themes.import" as const,
          params: {
            id: `applied-${round}-${index}`,
            definition: createThemeDefinitionFixture({ name: `Applied ${round}-${index}` }),
            apply: true,
            mode: "dark",
          },
          selectedId: `user/applied-${round}-${index}`,
        })),
        ...["rose", "tide"].map((id) => ({
          method: "themes.set" as const,
          params: { id, mode: "dark" },
          selectedId: id,
        })),
      ];
      const contenders = [...choices.slice(round), ...choices.slice(0, round)];
      const selections = await withConcurrentPreferenceSnapshots(contenders.length, () =>
        Promise.all(contenders.map(({ method, params }) => invoke(method, params))),
      );
      const winners = selections.flatMap((result, index) => (result.ok ? [index] : []));
      expect(winners).toHaveLength(1);
      const winnerIndex = expectDefined(winners[0], "winning theme mutation index");
      const winner = expectDefined(contenders[winnerIndex], "winning theme mutation");
      expected["ui.theme"] = winner.selectedId;
      expected["ui.themeMode"] = "dark";
      if (winner.method === "themes.import") {
        expected[`ui.themeDefinition.${winner.params.id}`] = winner.params.definition;
      }
      for (const [index, result] of selections.entries()) {
        expect(result).toMatchObject(
          index === winnerIndex
            ? {
                ok: true,
                payload: { current: { id: winner.selectedId, mode: "dark" }, application: "saved" },
              }
            : { ok: false, error: { message: expect.stringContaining("Appearance changed") } },
        );
      }
      expect(getUserPreferences(requesterProfileId)).toEqual(expected);
      expect(getUserPreferences(otherProfileId)).toEqual({});
      expect(await invoke("themes.list")).toMatchObject({
        ok: true,
        payload: {
          current: { id: winner.selectedId, mode: "dark" },
          themes: expect.arrayContaining(
            ids.map((id) => expect.objectContaining({ id: `user/${id}` })),
          ),
        },
      });
      expect(await invoke("themes.get")).toMatchObject({
        ok: true,
        payload: {
          current: { id: winner.selectedId, mode: "dark" },
          theme: { id: winner.selectedId },
        },
      });
    }
  });

  it("reads and writes through a merged profile alias and notifies both identities only", async () => {
    const unrelatedId = ensureProfileForEmail("unrelated@example.test").id;
    linkEmail("requester@example.test", otherProfileId);
    const clients = [
      client(requesterProfileId),
      { ...client(otherProfileId), connId: "canonical-browser" },
      { ...client(unrelatedId), connId: "unrelated-browser" },
    ];
    const broadcastToConnIds = vi.fn();
    const definition = createThemeDefinitionFixture();
    expect(
      await invoke(
        "themes.import",
        { id: "merged", definition, apply: true, mode: "dark" },
        {
          context: {
            broadcastToConnIds,
            getClientConnIds: (filter) =>
              new Set(
                clients.filter((entry) => !filter || filter(entry)).map((entry) => entry.connId!),
              ),
          },
        },
      ),
    ).toMatchObject({
      ok: true,
      payload: { current: { id: "user/merged" }, application: "saved" },
    });
    expect(getUserPreferences(requesterProfileId)).toEqual({});
    expect(getUserPreferences(otherProfileId)).toEqual({
      "ui.themeDefinition.merged": definition,
      "ui.theme": "user/merged",
      "ui.themeMode": "dark",
    });
    expect(getUserPreferences(unrelatedId)).toEqual({});
    for (const profileId of [requesterProfileId, otherProfileId]) {
      expect(await invoke("themes.get", {}, { client: client(profileId) })).toMatchObject({
        ok: true,
        payload: { current: { id: "user/merged", mode: "dark" }, definition },
      });
    }
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "users.prefs.changed",
      {
        profileId: otherProfileId,
        keys: ["ui.themeDefinition.merged", "ui.theme", "ui.themeMode"],
      },
      new Set(["requester-browser", "canonical-browser"]),
    );
  });

  it("does not redirect a prepared import when its profile merges before the write", async () => {
    expect(setUserPreferences(requesterProfileId, { "ui.theme": "claw" }).ok).toBe(true);
    const targetPreferences = { "ui.theme": "tide", "ui.themeMode": "light" };
    expect(setUserPreferences(otherProfileId, targetPreferences).ok).toBe(true);
    const readPreferences = userPreferences.getCanonicalUserPreferences;
    vi.spyOn(userPreferences, "getCanonicalUserPreferences").mockImplementationOnce(
      async (...args) => {
        const snapshot = await readPreferences(...args);
        linkEmail("requester@example.test", otherProfileId);
        return snapshot;
      },
    );
    const broadcastToConnIds = vi.fn();
    expect(
      await invoke(
        "themes.import",
        { id: "stale", definition: createThemeDefinitionFixture(), apply: true },
        {
          context: { broadcastToConnIds, getClientConnIds: () => new Set(["requester-browser"]) },
        },
      ),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining("profile changed") } });
    expect(getUserPreferences(requesterProfileId)).toEqual({});
    expect(getUserPreferences(otherProfileId)).toEqual(targetPreferences);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("rolls back an import at the profile key limit while allowing replacement at capacity", async () => {
    const expected: Record<string, unknown> = {
      ...Object.fromEntries(
        Array.from({ length: 125 }, (_, index) => [`retained-${index}`, index]),
      ),
      "ui.theme": "claw",
      "ui.themeMode": "dark",
    };
    const entries = Object.entries(expected);
    for (let offset = 0; offset < entries.length; offset += 32) {
      expect(
        setUserPreferences(
          requesterProfileId,
          Object.fromEntries(entries.slice(offset, offset + 32)),
        ).ok,
      ).toBe(true);
    }
    const broadcastToConnIds = vi.fn();
    const options = {
      context: { broadcastToConnIds, getClientConnIds: () => new Set(["requester-browser"]) },
    };
    const definition = createThemeDefinitionFixture();
    expect(
      await invoke("themes.import", { id: "last", definition, apply: true, mode: "dark" }, options),
    ).toMatchObject({ ok: true });
    Object.assign(expected, { "ui.themeDefinition.last": definition, "ui.theme": "user/last" });
    expect(Object.keys(getUserPreferences(requesterProfileId))).toHaveLength(128);
    expect(getUserPreferences(requesterProfileId)).toEqual(expected);
    expect(
      await invoke("themes.import", { id: "overflow", definition, apply: true }, options),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("profile-key-limit") },
    });
    expect(getUserPreferences(requesterProfileId)).toEqual(expected);
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const replacement = createThemeDefinitionFixture({ name: "Updated at capacity" });
    expect(
      await invoke("themes.import", { id: "last", definition: replacement, apply: true }, options),
    ).toMatchObject({ ok: true });
    expected["ui.themeDefinition.last"] = replacement;
    expect(getUserPreferences(requesterProfileId)).toEqual(expected);
    expect(getUserPreferences(otherProfileId)).toEqual({});
    expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
  });

  it("retains a missing plugin selection and resumes it when the catalog is republished", async () => {
    pluginThemes.push(pluginTheme());
    expect(await invoke("themes.set", { id: "space-pack/xenovessel", mode: "dark" })).toMatchObject(
      { ok: true },
    );
    pluginThemes.length = 0;
    expect(await invoke("themes.get")).toMatchObject({
      ok: true,
      payload: {
        current: {
          id: "claw",
          requestedId: "space-pack/xenovessel",
          overrides: { id: "space-pack/xenovessel" },
        },
      },
    });
    expect(getUserPreferences(requesterProfileId)["ui.theme"]).toBe("space-pack/xenovessel");
    pluginThemes.push(pluginTheme());
    expect(await invoke("themes.get")).toMatchObject({
      ok: true,
      payload: { current: { id: "space-pack/xenovessel" } },
    });
  });

  it.each(["runtime", "ambient"])(
    "uses only the trusted %s requester's profile after its browser closes",
    async (source) => {
      const identity = runtimeIdentity(requesterProfileId);
      const synthetic = client(otherProfileId);
      synthetic.internal = {
        syntheticClient: true,
        ...(source === "runtime" ? { agentRuntimeIdentity: identity } : {}),
      };
      const action = () =>
        invoke(
          "themes.set",
          { mode: "dark" },
          {
            client: synthetic,
            context: {
              validateAgentRuntimeApprovalAuthority: (candidate) => candidate === identity,
            },
          },
        );
      const result =
        source === "runtime"
          ? await action()
          : await withGatewayToolCallerIdentity(
              {
                agentId: identity.agentId,
                sessionKey: identity.sessionKey,
                operationalRunInstance: identity.operationalRunInstance,
                receiptAuthority: () => true,
                gatewayUiCommandTarget: identity.gatewayUiCommandTarget,
              },
              action,
            );
      expect(result).toMatchObject({
        ok: true,
        payload: { current: { mode: "dark", scope: "profile" } },
      });
      expect(getUserPreferences(requesterProfileId)).toEqual({ "ui.themeMode": "dark" });
      expect(getUserPreferences(otherProfileId)).toEqual({});
    },
  );

  it.each([false, true])(
    "does not use a synthetic client's incidental profile when requester identity is absent (runtime=%s)",
    async (runtime) => {
      const synthetic = client(requesterProfileId);
      synthetic.internal = {
        syntheticClient: true,
        ...(runtime ? { agentRuntimeIdentity: runtimeIdentity() } : {}),
      };
      expect(await invoke("themes.set", { mode: "dark" }, { client: synthetic })).toMatchObject({
        ok: false,
      });
      expect(getUserPreferences(requesterProfileId)).toEqual({});
    },
  );

  it("rejects model-selected profile targeting", async () => {
    for (const method of ["themes.set", "themes.import"] as const) {
      const params =
        method === "themes.set"
          ? { mode: "dark" }
          : { id: "forged", definition: createThemeDefinitionFixture(), apply: true };
      expect(await invoke(method, { ...params, profileId: otherProfileId })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
    expect(getUserPreferences(requesterProfileId)).toEqual({});
    expect(getUserPreferences(otherProfileId)).toEqual({});
  });

  it.each(
    ["select", "mode-only"].flatMap((action) =>
      ["replaced", "unavailable"].map((change) => ({ action, change })),
    ),
  )("refuses a plugin palette $change before commit during $action", async ({ action, change }) => {
    const installed = pluginTheme();
    pluginThemes.push(installed);
    const original = {
      "ui.theme": action === "select" ? "claw" : installed.id,
      "ui.themeMode": "system",
      "ui.accent": "#aabbcc",
    };
    expect(setUserPreferences(requesterProfileId, original).ok).toBe(true);
    let reachedCommit = false;
    beforeWorkerCommit(() => {
      reachedCommit = true;
      if (change === "unavailable") {
        pluginThemes.length = 0;
        return;
      }
      pluginThemes[0] = {
        ...installed,
        modes: ["light"],
        definition: {
          name: installed.name,
          description: "Replacement light-only palette",
          light: createThemePaletteFixture(),
        },
      };
    });
    const params = action === "select" ? { id: installed.id, mode: "dark" } : { mode: "dark" };
    expect(await invoke("themes.set", params)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("theme plugin changed") },
    });
    expect(reachedCommit).toBe(true);
    expect(getUserPreferences(requesterProfileId)).toEqual(original);
  });

  it("rolls back both import and selection when the live run retires at the commit boundary", async () => {
    const identity = runtimeIdentity(requesterProfileId);
    const synthetic = client();
    synthetic.internal = { syntheticClient: true, agentRuntimeIdentity: identity };
    let active = true;
    let reachedCommit = false;
    beforeWorkerCommit(() => {
      reachedCommit = true;
      active = false;
    });
    expect(
      await invoke(
        "themes.import",
        { id: "retired", definition: createThemeDefinitionFixture(), apply: true },
        {
          client: synthetic,
          context: { validateAgentRuntimeApprovalAuthority: () => active },
        },
      ),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining("no longer active") } });
    expect(reachedCommit).toBe(true);
    expect(getUserPreferences(requesterProfileId)).toEqual({});
  });
});
