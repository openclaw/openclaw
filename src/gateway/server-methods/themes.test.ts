import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ThemeCatalogEntry } from "../../../packages/gateway-protocol/src/theme.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createThemeDefinitionFixture as themeDefinition,
  createThemePaletteFixture as themePalette,
} from "../../../test/helpers/theme-fixture.js";
import {
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  createPersonalThemeToolCaller,
  withPersonalToolTurn,
} from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import * as userPreferences from "../../state/user-preferences.js";
import {
  getUserPreferences,
  setUserPreferences,
} from "../../state/user-preferences.test-support.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { forbidMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { themeHandlers } from "./themes.js";
import { pluginTheme } from "./themes.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const { pluginThemes } = vi.hoisted(() => ({ pluginThemes: [] as ThemeCatalogEntry[] }));
vi.mock("../../plugins/theme-catalog.js", () => ({ listPluginThemes: () => pluginThemes }));

let state: OpenClawTestState;
let requesterId: string;
let otherId: string;
let profileCatalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>>;

beforeEach(async () => {
  pluginThemes.length = 0;
  state = await createOpenClawTestState({ layout: "state-only", prefix: "themes-rpc-" });
  requesterId = ensureProfileForEmail("requester@example.test").id;
  otherId = ensureProfileForEmail("other@example.test").id;
  profileCatalog = await prepareUserProfileCatalog();
});

afterEach(async () => {
  vi.restoreAllMocks();
  profileCatalog.release();
  await state.cleanup();
});

function client(profileId?: string): GatewayClient {
  const result: GatewayClient = {
    connId: "requester-browser",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.write"],
      client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, version: "test", platform: "test", mode: "ui" },
    },
  };
  if (profileId) {
    result.authenticatedUserProfile = {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    };
  }
  return result;
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
  method: string,
  params: Record<string, unknown> = {},
  options: Partial<Omit<GatewayRequestHandlerOptions, "context">> & {
    context?: Partial<GatewayRequestContext>;
  } = {},
) {
  const { context, ...requestOptions } = options;
  let result: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
  const handler = expectDefined(themeHandlers[method], "theme handler");
  await handler({
    req: { type: "req", id: "theme-request", method, params },
    params,
    client: client(requesterId),
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: { getRuntimeConfig: () => ({}), ...context },
    ...requestOptions,
  } as GatewayRequestHandlerOptions);
  return expectDefined(result, "theme RPC response");
}

function seedPreferences(entries: Record<string, unknown>, profileId = requesterId) {
  expect(setUserPreferences(profileId, entries).ok).toBe(true);
}

function preferences(entries: Record<string, unknown> = {}, profileId = requesterId) {
  expect(getUserPreferences(profileId)).toEqual(entries);
}

function themePreferences(id: string, mode = "dark") {
  return { "ui.theme": id, "ui.themeMode": mode };
}

const success = (payload?: unknown) => ({
  ok: true,
  ...(payload === undefined ? {} : { payload }),
});
const failure = (error?: Partial<ErrorShape>) => ({ ok: false, ...(error ? { error } : {}) });
const messageError = (message: string) => failure({ message: expect.stringContaining(message) });

async function expectRpc(response: ReturnType<typeof invoke>, payload?: unknown) {
  expect(await response).toMatchObject(success(payload));
}

async function expectError(
  response: ReturnType<typeof invoke>,
  error?: string | Partial<ErrorShape>,
) {
  expect(await response).toMatchObject(
    typeof error === "string" ? messageError(error) : failure(error),
  );
}

function importTheme(
  id: string,
  params: Record<string, unknown> = {},
  options?: Parameters<typeof invoke>[2],
) {
  return invoke("themes.import", { id, definition: themeDefinition(), ...params }, options);
}

function setTheme(params: Record<string, unknown>, options?: Parameters<typeof invoke>[2]) {
  return invoke("themes.set", params, options);
}

function broadcastOptions(clients = [client(requesterId)]) {
  const context = {
    broadcastToConnIds: vi.fn(),
    getClientConnIds: ((filter) =>
      new Set(
        clients.filter((entry) => !filter || filter(entry)).map((entry) => entry.connId!),
      )) satisfies GatewayRequestContext["getClientConnIds"],
  };
  return { context };
}

function expectImportBroadcast(
  options: ReturnType<typeof broadcastOptions>,
  id: string,
  profileId = requesterId,
  connIds = ["requester-browser"],
) {
  expect(options.context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
    "users.prefs.changed",
    { profileId, keys: [`ui.themeDefinition.${id}`, "ui.theme", "ui.themeMode"] },
    new Set(connIds),
  );
}

const daylight = () => ({
  name: "Daylight",
  description: "Light-only replacement",
  light: themePalette(),
});

function beforeWorkerCommit(checkpoint: () => void) {
  probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      checkpoint();
    }
    admit(request, grant);
  });
}

function afterSnapshot(checkpoint: () => void | Promise<void>) {
  const readPreferences = userPreferences.getCanonicalUserPreferences;
  vi.spyOn(userPreferences, "getCanonicalUserPreferences").mockImplementationOnce(
    async (...args) => {
      const snapshot = await readPreferences(...args);
      await checkpoint();
      return snapshot;
    },
  );
}

function changePreferencesAfterSnapshot(entries: Record<string, unknown>) {
  afterSnapshot(async () => {
    expect(await userPreferences.setCanonicalUserPreferences(requesterId, entries)).toMatchObject(
      success(),
    );
  });
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

it("lists descriptive choices and inspects a plugin definition without exposing palettes in list entries", async () => {
  const entry = {
    ...pluginTheme(),
    artwork: {
      hats: {
        beret: { url: "/__openclaw__/plugin-theme-art/space-pack/xenovessel/hat/beret?v=abc" },
      },
      critters: {
        ferris: {
          url: "/__openclaw__/plugin-theme-art/space-pack/xenovessel/critter/ferris?v=def",
          title: "a crab, allegedly",
          crossMs: 15000,
        },
      },
    },
  };
  pluginThemes.push(entry);
  const { definition, ...descriptor } = entry;
  await expectRpc(invoke("themes.list", {}), {
    current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
    themes: expect.arrayContaining([
      expect.objectContaining({ id: "claw", description: expect.stringMatching(/\S/) }),
      descriptor,
    ]),
  });
  await expectRpc(invoke("themes.get", { id: descriptor.id }), {
    theme: descriptor,
    definition,
    artwork: entry.artwork,
  });
  expect(await invoke("themes.get", { id: "claw" })).not.toHaveProperty("payload.artwork");
});

it("imports and applies in one durable profile mutation, preserving other preferences and notifying only that profile", async () => {
  seedPreferences({ "ui.accent": "#aabbcc", "ui.fontFamily": "serif" });
  const options = broadcastOptions([
    client(requesterId),
    { ...client(otherId), connId: "other-browser" },
  ]);
  const branding = {
    mascot: "none",
    brandName: "Mission Control",
    brandIcon: "mark",
    workingIndicator: "brand",
    lobsterdex: false,
    communityLinks: false,
    workingPhrases: ["Building", "Compiling"],
    critters: ["penguin", "fedora"],
    avatarHat: "fedora",
  } satisfies Parameters<typeof themeDefinition>[0];
  const definition = themeDefinition(branding);
  await expectRpc(importTheme("xenovessel", { definition, apply: true, mode: "dark" }, options), {
    current: { id: "user/xenovessel", mode: "dark", scope: "profile" },
    theme: { id: "user/xenovessel", source: "user", ...branding },
    definition,
    application: "saved",
  });
  expectImportBroadcast(options, "xenovessel");
  await closeOpenClawStateDatabaseAsync();
  preferences({
    "ui.accent": "#aabbcc",
    "ui.fontFamily": "serif",
    "ui.themeDefinition.xenovessel": definition,
    "ui.theme": "user/xenovessel",
    "ui.themeMode": "dark",
  });
  preferences({}, otherId);
  await expectRpc(invoke("themes.get", { id: "user/xenovessel" }), { theme: branding, definition });
  await expectRpc(invoke("themes.list", {}), {
    themes: expect.arrayContaining([
      expect.objectContaining({ id: "user/xenovessel", ...branding }),
    ]),
  });
});

it("validates and persists theme selection with accompanying appearance changes as one batch", async () => {
  pluginThemes.push(pluginTheme());
  const original = {
    ...themePreferences("claw", "light"),
    "ui.accent": "#aabbcc",
    "ui.fontUi": "geist",
    "ui.fontChat": "lora",
    "chat.showThinking": true,
  };
  seedPreferences(original);
  const params = {
    id: "space-pack/xenovessel",
    appearance: { accent: "#A1B2C3", fontUi: "jetbrains-mono", fontChat: null },
  };
  await expectError(setTheme({ ...params, mode: "light" }), "does not provide light mode");
  preferences(original);
  await expectRpc(setTheme({ ...params, mode: "dark" }), {
    current: { id: params.id, mode: "dark" },
    application: "saved",
  });
  preferences({
    ...themePreferences(params.id),
    "ui.accent": "#a1b2c3",
    "ui.fontUi": "jetbrains-mono",
    "chat.showThinking": true,
  });
});

it.each([
  { background: "url(https://example.test/collect)" },
  { "font-sans": "sans-serif; background: red" },
])(
  "rejects unsafe or malformed theme values without importing or selecting: %j",
  async (palette) => {
    const definition = themeDefinition();
    definition.dark = { ...definition.dark!, ...palette };
    await expectError(importTheme("unsafe", { definition, apply: true }));
    preferences();
  },
);

it("clears theme overrides against Gateway defaults while retaining saved custom themes", async () => {
  const definition = themeDefinition();
  await expectRpc(importTheme("dark", { definition, apply: true, mode: "dark" }));
  await expectRpc(setTheme({ id: null, mode: "light" }), {
    current: { id: "claw", mode: "light", overrides: { mode: "light" } },
  });
  await expectRpc(
    setTheme(
      { mode: null },
      { context: { getRuntimeConfig: () => ({ ui: { prefs: { themeMode: "dark" } } }) } },
    ),
    { current: { id: "claw", mode: "dark", overrides: {} } },
  );
  preferences({ "ui.themeDefinition.dark": definition });
});

it("selects a dark-only imported theme in one call and refuses explicit incompatible modes without writes", async () => {
  const definition = themeDefinition();
  const original = themePreferences("claw", "light");
  seedPreferences(original);
  const params = { id: "xenovessel", definition, apply: true };
  const incompatible = { message: expect.stringContaining("does not provide light mode") };
  await expectError(invoke("themes.import", { ...params, mode: "light" }), incompatible);
  preferences(original);
  await expectRpc(invoke("themes.import", params), {
    current: { id: "user/xenovessel", mode: "dark" },
    application: "saved",
  });
  const saved = {
    ...themePreferences("user/xenovessel"),
    "ui.themeDefinition.xenovessel": definition,
  };
  preferences(saved);
  for (const mode of ["light", null]) {
    await expectError(
      setTheme(
        { mode },
        {
          context: { getRuntimeConfig: () => ({ ui: { prefs: { themeMode: "light" } } }) },
        },
      ),
      incompatible,
    );
    preferences(saved);
  }
});

it("does not change another client's new selection when reimporting a previously selected theme", async () => {
  const original = themeDefinition();
  await expectRpc(importTheme("adaptive", { definition: original, apply: true, mode: "dark" }));
  changePreferencesAfterSnapshot(themePreferences("claw"));
  const replacement = daylight();
  await expectError(importTheme("adaptive", { definition: replacement }), {
    code: "INVALID_REQUEST",
  });
  preferences({
    ...themePreferences("claw"),
    "ui.themeDefinition.adaptive": original,
  });
});

it("refuses a personal theme selection when another client replaces its prepared palette", async () => {
  await expectRpc(importTheme("adaptive"));
  const replacement = daylight();
  changePreferencesAfterSnapshot({ "ui.themeDefinition.adaptive": replacement });
  await expectError(setTheme({ id: "user/adaptive", mode: "dark" }), { code: "INVALID_REQUEST" });
  preferences({ "ui.themeDefinition.adaptive": replacement });
});

it("preserves independent concurrent imports and atomically settles competing selections", async () => {
  const expected: Record<string, unknown> = { "chat.showThinking": true };
  seedPreferences(expected);
  for (let round = 0; round < 4; round += 1) {
    Object.assign(expected, themePreferences("claw", "system"));
    seedPreferences(themePreferences("claw", "system"));
    const ids = Array.from({ length: 4 }, (_, index) => `independent-${round}-${index}`);
    const definitions = ids.map((name) => themeDefinition({ name }));
    const imports = await withConcurrentPreferenceSnapshots(ids.length, () =>
      Promise.all(ids.map((id, index) => importTheme(id, { definition: definitions[index] }))),
    );
    for (const [index, result] of imports.entries()) {
      expect(result).toMatchObject(success({ application: "saved" }));
      expected[`ui.themeDefinition.${ids[index]}`] = definitions[index];
    }
    preferences(expected);

    const choices = [
      ...[0, 1].map((index) => ({
        method: "themes.import" as const,
        params: {
          id: `applied-${round}-${index}`,
          definition: themeDefinition({ name: `Applied ${round}-${index}` }),
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
          ? success({ current: { id: winner.selectedId, mode: "dark" }, application: "saved" })
          : messageError("Appearance changed"),
      );
    }
    preferences(expected);
    preferences({}, otherId);
    await expectRpc(invoke("themes.list", {}), {
      current: { id: winner.selectedId, mode: "dark" },
      themes: expect.arrayContaining(
        ids.map((id) => expect.objectContaining({ id: `user/${id}` })),
      ),
    });
    await expectRpc(invoke("themes.get", {}), {
      current: { id: winner.selectedId, mode: "dark" },
      theme: { id: winner.selectedId },
    });
  }
});

it("reads and writes through a merged profile alias and notifies both identities only", async () => {
  const unrelatedId = ensureProfileForEmail("unrelated@example.test").id;
  linkEmail("requester@example.test", otherId);
  const clients = [
    client(requesterId),
    { ...client(otherId), connId: "canonical-browser" },
    { ...client(unrelatedId), connId: "unrelated-browser" },
  ];
  const options = broadcastOptions(clients);
  const definition = themeDefinition();
  const sql = forbidMainThreadSql("theme identity and notification queried host SQLite");
  let result: Awaited<ReturnType<typeof invoke>>;
  try {
    result = await importTheme("merged", { definition, apply: true, mode: "dark" }, options);
  } finally {
    sql.restore();
  }
  expect(result).toMatchObject(success({ current: { id: "user/merged" }, application: "saved" }));
  preferences();
  preferences(
    {
      "ui.themeDefinition.merged": definition,
      ...themePreferences("user/merged"),
    },
    otherId,
  );
  preferences({}, unrelatedId);
  for (const profileId of [requesterId, otherId]) {
    await expectRpc(invoke("themes.get", {}, { client: client(profileId) }), {
      current: { id: "user/merged", mode: "dark" },
      definition,
    });
  }
  expectImportBroadcast(options, "merged", otherId, ["requester-browser", "canonical-browser"]);
});

it("does not redirect a prepared import when its profile merges before the write", async () => {
  seedPreferences({ "ui.theme": "claw" });
  const targetPreferences = themePreferences("tide", "light");
  seedPreferences(targetPreferences, otherId);
  afterSnapshot(() => {
    linkEmail("requester@example.test", otherId);
  });
  const options = broadcastOptions();
  const { broadcastToConnIds } = options.context;
  await expectError(importTheme("stale", { apply: true }, options), "profile changed");
  preferences();
  preferences(targetPreferences, otherId);
  expect(broadcastToConnIds).not.toHaveBeenCalled();
});

it("rolls back an import at the profile key limit while allowing replacement at capacity", async () => {
  const expected: Record<string, unknown> = {
    ...Object.fromEntries(Array.from({ length: 125 }, (_, index) => [`retained-${index}`, index])),
    ...themePreferences("claw"),
  };
  const entries = Object.entries(expected);
  for (let offset = 0; offset < entries.length; offset += 32) {
    seedPreferences(Object.fromEntries(entries.slice(offset, offset + 32)));
  }
  const options = broadcastOptions();
  const { broadcastToConnIds } = options.context;
  const definition = themeDefinition();
  await expectRpc(importTheme("last", { definition, apply: true, mode: "dark" }, options));
  Object.assign(expected, { "ui.themeDefinition.last": definition, "ui.theme": "user/last" });
  expect(Object.keys(getUserPreferences(requesterId))).toHaveLength(128);
  preferences(expected);
  await expectError(
    importTheme("overflow", { definition, apply: true }, options),
    "profile-key-limit",
  );
  preferences(expected);
  expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
  const replacement = themeDefinition({ name: "Updated at capacity" });
  await expectRpc(importTheme("last", { definition: replacement, apply: true }, options));
  expected["ui.themeDefinition.last"] = replacement;
  preferences(expected);
  preferences({}, otherId);
  expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
});

it("retains a missing plugin selection and resumes it when the catalog is republished", async () => {
  pluginThemes.push(pluginTheme());
  await expectRpc(setTheme({ id: "space-pack/xenovessel", mode: "dark" }));
  pluginThemes.length = 0;
  await expectRpc(invoke("themes.get", {}), {
    current: {
      id: "claw",
      requestedId: "space-pack/xenovessel",
      overrides: { id: "space-pack/xenovessel" },
    },
  });
  expect(getUserPreferences(requesterId)["ui.theme"]).toBe("space-pack/xenovessel");
  pluginThemes.push(pluginTheme());
  await expectRpc(invoke("themes.get", {}), { current: { id: "space-pack/xenovessel" } });
});

it.each(["runtime", "ambient"])(
  "uses only the trusted %s requester's profile after its browser closes",
  async (source) => {
    const identity = runtimeIdentity(requesterId);
    const synthetic = client(otherId);
    synthetic.internal = {
      syntheticClient: true,
      ...(source === "runtime" ? { agentRuntimeIdentity: identity } : {}),
    };
    const action = () =>
      setTheme(
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
    expect(result).toMatchObject(success({ current: { mode: "dark", scope: "profile" } }));
    preferences({ "ui.themeMode": "dark" });
    preferences({}, otherId);
  },
);

it("keeps every personal theme action scoped to the selected accepted turn participant", async () => {
  const owner = { profileId: requesterId, senderId: "alice-sender", name: "Alice" };
  const steerer = { profileId: otherId, senderId: "bob-sender", name: "Bob" };
  const ownerChoice = `Alice (user: ${owner.profileId})`;
  const bothChoices = `${ownerChoice}, Bob (user: ${steerer.profileId})`;
  const revoked = "Bob's access changed; ask them again";
  const synthetic = client();
  const execute = await createPersonalThemeToolCaller((method, params) =>
    invoke(method, params, { client: synthetic }),
  );
  const actions = [
    { action: "list" },
    { action: "get" },
    { action: "set", mode: "dark" },
    { action: "import", id: "personal", definition: themeDefinition(), apply: true },
  ];

  await withPersonalToolTurn({ owner }, async (turn) => {
    synthetic.internal = { syntheticClient: true, agentRuntimeIdentity: turn.runtimeIdentity };
    const current = { mode: "dark" };
    expect(await execute({ action: "set", mode: "dark" })).toMatchObject({ current });
    expect(await execute({ action: "get" }, owner.profileId)).toMatchObject({ current });
    await expect(execute({ action: "get" }, owner.senderId)).rejects.toThrow(ownerChoice);
    for (const action of actions) {
      await expect(execute(action, steerer.profileId)).rejects.toThrow();
    }
    preferences({}, otherId);

    afterSnapshot(async () => {
      expect(await turn.steer(steerer)).toMatchObject({ status: "accepted" });
    });
    await expect(execute({ action: "set", id: "tide" })).rejects.toThrow(ownerChoice);
    for (const action of actions) {
      for (const call of [
        () => execute(action),
        () => withoutGatewayToolCallerIdentity(() => execute(action)),
      ]) {
        await expect(call()).rejects.toThrow(bothChoices);
      }
      await expect(execute(action, "nonparticipant")).rejects.toThrow(bothChoices);
      await expect(execute(action, steerer.senderId)).rejects.toThrow("User is not a participant");
    }
    preferences({ "ui.themeMode": "dark" });
    preferences({}, otherId);

    for (const { person, id, mode } of [
      { person: steerer, id: "tide", mode: "light" },
      { person: owner, id: "rose", mode: "dark" },
    ]) {
      for (const action of ["set", "list", "get"]) {
        expect(
          await execute({ action, ...(action === "set" ? { id, mode } : {}) }, person.profileId),
        ).toMatchObject({ current: { id, mode } });
      }
      preferences(themePreferences(id, mode), person.profileId);
    }
    const imported = expectDefined(actions[3], "import action");
    expect(await execute(imported, steerer.profileId)).toMatchObject({
      current: { id: "user/personal" },
    });
    expect(getUserPreferences(requesterId)).not.toHaveProperty("ui.themeDefinition.personal");
    expect(getUserPreferences(otherId)).toMatchObject({
      "ui.themeDefinition.personal": imported.definition,
      "ui.theme": "user/personal",
    });

    const saved = getUserPreferences(otherId);
    const revokeBeforeCommit = vi.fn(() => turn.revoke(steerer.profileId));
    beforeWorkerCommit(revokeBeforeCommit);
    await expect(execute({ action: "set", id: "claw" }, steerer.profileId)).rejects.toThrow(
      revoked,
    );
    expect(revokeBeforeCommit).toHaveBeenCalled();
    preferences(saved, otherId);
    for (const action of actions) {
      await expect(execute(action, steerer.profileId)).rejects.toThrow(revoked);
    }
    expect(await execute({ action: "get" }, owner.profileId)).toMatchObject({
      current: { id: "rose" },
    });
    await turn.complete();
    expect(turn.releaseCounts.get(steerer.profileId)).toBe(1);
    await expect(execute({ action: "get" }, owner.profileId)).rejects.toThrow();
  });
});

it.each([false, true])(
  "does not use a synthetic client's incidental profile when requester identity is absent (runtime=%s)",
  async (runtime) => {
    const synthetic = client(requesterId);
    synthetic.internal = {
      syntheticClient: true,
      ...(runtime ? { agentRuntimeIdentity: runtimeIdentity() } : {}),
    };
    await expectError(setTheme({ mode: "dark" }, { client: synthetic }));
    preferences();
  },
);

it("rejects model-selected profile targeting", async () => {
  for (const method of ["themes.set", "themes.import"] as const) {
    const params =
      method === "themes.set"
        ? { mode: "dark" }
        : { id: "forged", definition: themeDefinition(), apply: true };
    await expectError(invoke(method, { ...params, profileId: otherId }), {
      code: "INVALID_REQUEST",
    });
  }
  preferences();
  preferences({}, otherId);
});

it("rolls back both import and selection when the live run retires at the commit boundary", async () => {
  const identity = runtimeIdentity(requesterId);
  const synthetic = client();
  synthetic.internal = { syntheticClient: true, agentRuntimeIdentity: identity };
  let active = true;
  let reachedCommit = false;
  beforeWorkerCommit(() => {
    reachedCommit = true;
    active = false;
  });
  await expectError(
    importTheme(
      "retired",
      { apply: true },
      {
        client: synthetic,
        context: { validateAgentRuntimeApprovalAuthority: () => active },
      },
    ),
    "no longer active",
  );
  expect(reachedCommit).toBe(true);
  preferences();
});
