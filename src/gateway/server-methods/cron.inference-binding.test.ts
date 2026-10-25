import { describe, expect, test } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.entry.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import {
  createParams,
  platformId,
  sessionKey,
  subscriptionId,
  withFixture,
} from "./cron.inference-binding.test-support.js";
import { createCronCallerClient } from "./cron.validation.test-support.js";

type Fixture = Parameters<Parameters<typeof withFixture>[0]>[0];
const it = test.extend<{ fixture: Fixture }>({
  fixture: async ({ task: _task }, use) => {
    await withFixture(use);
  },
});
type Caller = Parameters<Fixture["invoke"]>[2];
const creatorClient = () => createCronCallerClient("main", undefined, sessionKey);
const addForCreator = (fixture: Fixture) =>
  fixture.invoke("cron.add", createParams(), creatorClient());
const updateModel = (fixture: Fixture, id: string, model: string, client?: Caller) =>
  fixture.invoke("cron.update", { id, patch: { payload: { kind: "agentTurn", model } } }, client);
function modelParams(model?: string, sessionTarget?: string) {
  const params = createParams();
  return {
    ...params,
    ...(sessionTarget ? { sessionTarget } : {}),
    payload: { ...params.payload, ...(model ? { model } : {}) },
  };
}
const binding = (profileId: string, source: "user" | "auto", authRequirement: string) => ({
  provider: "openai",
  profileId,
  authRequirement,
  source,
});
const nativeAuthority: CronRuntimeAuthority = {
  version: 1,
  runtimeId: "synthetic-native",
  namespace: "synthetic.inference",
  payload: { account: "synthetic-native-account" },
};
function captureAuthority(
  client: ReturnType<typeof creatorClient>,
  authority?: CronRuntimeAuthority,
) {
  const identity = client.internal!.agentRuntimeIdentity!;
  const scope = createCronCreatorAuthorityRunScope(identity.operationalRunInstance.runId);
  identity.cronToolsAllowCapture = "final-executable-surface";
  identity.cronCreatorAuthorityGrant = mintCronCreatorAuthorityGrant(scope, undefined, authority);
  return { [Symbol.dispose]: () => revokeCronCreatorAuthorityRunScope(scope) };
}

describe("cron handler inference binding persistence", () => {
  it.for([
    ["native", "absent"],
    ["worker", "absent"],
    ["worker", "ambient"],
    ["direct", "environment"],
    ["direct", "configuration"],
    ["local", "configured"],
  ] as const)(
    "keeps %s inference unbound with %s credentials",
    async ([runtime, source], { fixture }) => {
      const key = "synthetic-direct-key";
      if (source !== "ambient") {
        await fixture.useUnstoredCredential(
          runtime === "local" ? "ollama" : "openai",
          source === "configuration" ? key : undefined,
        );
      }
      if (runtime === "native") {
        fixture.setCodexRuntime();
      }
      if (runtime === "worker") {
        fixture.setWorkerInference(true, "worker");
      }
      await withEnvAsync(
        { OPENAI_API_KEY: source === "environment" ? key : undefined },
        async () => {
          await fixture.invoke("cron.add", createParams());
          const job = await fixture.reload();
          expect(job.enabled).toBe(false);
          expect(job.inferenceBinding).toBeUndefined();
        },
      );
    },
  );

  it.for([
    [{ runtime: "openclaw" }, undefined, "stored inference account"],
    [{ registered: false }, undefined, "codex"],
    [{ supported: false }, undefined, "does not support"],
    [{}, "codex/openai-compatible/gpt-5.4@missing-account", "missing-account"],
  ] as const)(
    "rejects unavailable inference (%s, %s): %s",
    async ([runtime, model, error], { fixture }) => {
      await fixture.useUnstoredCredential("openai");
      fixture.setCodexRuntime(runtime);
      const failure = await fixture.invoke("cron.add", modelParams(model), null, {
        expectedSuccess: false,
      });
      expect(failure).toMatchObject({ message: expect.stringContaining(error) });
      expect(await fixture.status()).toMatchObject({ jobs: 0 });
    },
  );

  it.for([
    { name: "optional worker", required: false, inference: "worker" },
    { name: "required Gateway inference", required: true, inference: "gateway" },
  ] as const)(
    "retains host credential validation for $name",
    async ({ required, inference }, { fixture }) => {
      await fixture.useUnstoredCredential("openai");
      fixture.setWorkerInference(required, inference);
      const error = await fixture.invoke("cron.add", createParams(), null, {
        expectedSuccess: false,
      });
      expect(error).toMatchObject({
        message: expect.stringContaining("No route-compatible authentication source"),
      });
      expect(await fixture.status()).toMatchObject({ jobs: 0 });
    },
  );

  it.for(["model", "creator", "default"] as const)(
    "validates a selected %s account even with required worker inference",
    async (selection, { fixture }) => {
      await fixture.useUnstoredCredential("openai");
      fixture.setWorkerInference(true, "worker");
      if (selection === "creator") {
        await fixture.setCreator(platformId);
      } else if (selection === "default") {
        fixture.setDefaultProfile(platformId);
      }
      const model = selection === "model" ? "openai/gpt-4.1@" + platformId : "openai/gpt-4.1";
      const error = await fixture.invoke(
        "cron.add",
        modelParams(selection === "creator" ? undefined : model),
        selection === "creator" ? createCronCallerClient("main", undefined, sessionKey) : null,
        { expectedSuccess: false },
      );
      expect(error).toMatchObject({ message: expect.stringContaining(platformId) });
      expect(await fixture.status()).toMatchObject({ jobs: 0 });
    },
  );

  it.for(["add", "update"] as const)(
    "rejects credential replacement after capture before %s commit",
    async (method, { fixture }) => {
      if (method === "update") {
        await fixture.invoke("cron.add", createParams());
      }
      const original = method === "update" ? await fixture.reload() : undefined;
      const mutation = fixture.replaceAccountBeforeMutation(method);
      try {
        await expect(
          method === "add"
            ? fixture.invoke("cron.add", createParams())
            : fixture.invoke("cron.update", {
                id: original?.id,
                patch: { payload: { kind: "agentTurn", model: "openai/gpt-4.1@" + platformId } },
              }),
        ).rejects.toThrow(/MCP authorization/);
        if (original) {
          expect((await fixture.reload()).inferenceBinding).toEqual(original.inferenceBinding);
        } else {
          expect(await fixture.status()).toMatchObject({ jobs: 0 });
        }
      } finally {
        mutation.mockRestore();
      }
    },
  );

  it("requires the personal owner for explicit creation and account adoption", async ({
    fixture,
  }) => {
    const personal = await fixture.personalAccount();
    const params = modelParams("openai/gpt-4.1@" + personal.profileId);
    const agent = createCronCallerClient("main", undefined, sessionKey);
    for (const caller of [null, agent, personal.other]) {
      await fixture.invoke("cron.add", params, caller, { expectedSuccess: false });
    }
    expect(await fixture.status()).toMatchObject({ jobs: 0 });
    await fixture.invoke("cron.add", createParams(), personal.owner);
    const created = await fixture.reload();
    const originalBinding = created.inferenceBinding;
    const patch = { id: created.id, patch: { payload: params.payload } };
    for (const caller of [agent, personal.other]) {
      await fixture.invoke("cron.update", patch, caller, { expectedSuccess: false });
    }
    expect((await fixture.reload()).inferenceBinding).toEqual(originalBinding);
    await expect(
      fixture.invoke("cron.update", patch, personal.owner, {
        beforeCommit: () => {
          personal.owner.invalidated = true;
        },
      }),
    ).rejects.toThrow("current authorized connection");
    expect((await fixture.reload()).inferenceBinding).toEqual(originalBinding);
    personal.owner.invalidated = false;
    await fixture.invoke("cron.update", patch, personal.owner);
    expect((await fixture.reload()).inferenceBinding).toMatchObject({
      profileId: personal.profileId,
      source: "user",
      authRequirement: "api-key",
    });
  });

  it("inherits a trusted creator's personal selection without turning it into a new user pin", async ({
    fixture,
  }) => {
    const personal = await fixture.personalAccount();
    await fixture.setCreator(personal.profileId);
    await addForCreator(fixture);
    expect((await fixture.reload()).inferenceBinding).toMatchObject({
      profileId: personal.profileId,
      source: "auto",
      authRequirement: "api-key",
    });
  });

  it("rejects an agent move that changes credential ownership unless an account is adopted", async ({
    fixture,
  }) => {
    await fixture.invoke("cron.add", createParams());
    const created = await fixture.reload();
    fixture.addAgent("secondary");
    await fixture.invoke("cron.update", { id: created.id, patch: { agentId: "main" } });
    expect((await fixture.reload()).inferenceBinding).toEqual(created.inferenceBinding);
    await fixture.invoke("cron.update", { id: created.id, patch: { agentId: "secondary" } }, null, {
      expectedSuccess: false,
    });
    const unchanged = await fixture.reload();
    expect(unchanged.agentId).toBe("main");
    expect(unchanged.inferenceBinding).toEqual(created.inferenceBinding);
    await fixture.invoke("cron.update", {
      id: created.id,
      patch: {
        agentId: "secondary",
        payload: { kind: "agentTurn", model: "openai/gpt-4.1@" + platformId },
      },
    });
    const moved = await fixture.reload();
    expect(moved.agentId).toBe("secondary");
    expect(moved.inferenceBinding).toMatchObject({ profileId: platformId, source: "user" });
    expect(moved.inferenceBinding?.authorizationId).not.toBe(
      created.inferenceBinding?.authorizationId,
    );
  });

  it("adopts an explicit account on an aliased model but not on a plain alias", async ({
    fixture,
  }) => {
    fixture.setAlias();
    await fixture.invoke("cron.add", createParams());
    const created = await fixture.reload();
    await updateModel(fixture, created.id, "synthetic-alias@" + subscriptionId);
    const adopted = await fixture.reload();
    expect(adopted.inferenceBinding).toMatchObject({ profileId: subscriptionId, source: "user" });
    await updateModel(fixture, created.id, "synthetic-alias");
    expect((await fixture.reload()).inferenceBinding).toEqual(adopted.inferenceBinding);
  });
  it.for([
    { profileId: platformId, other: subscriptionId, requirement: "api-key" },
    { profileId: subscriptionId, other: platformId, requirement: "subscription" },
  ])(
    "keeps the creator's $requirement binding until an explicit model@profile update",
    async ({ profileId, other, requirement }, { fixture }) => {
      await fixture.setCreator(profileId);
      const client = creatorClient();
      await fixture.invoke("cron.add", createParams(), client);
      const created = await fixture.reload();
      expect(created.inferenceBinding).toEqual({
        version: 1,
        ...binding(profileId, "auto", requirement),
        authorizationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const originalBinding = created.inferenceBinding;
      await fixture.changeDefaults(other);
      await fixture.setCreator(other);
      await updateModel(fixture, created.id, "openai/gpt-4o", client);
      const preserved = await fixture.reload();
      expect(preserved.payload).toMatchObject({ model: "openai/gpt-4o" });
      expect(preserved.inferenceBinding).toEqual(originalBinding);
      await fixture.invoke("cron.get", { id: created.id });
      await fixture.invoke("cron.list", {
        includeDisabled: true,
        includeDeliveryPreviews: false,
      });

      await updateModel(fixture, created.id, "openai/gpt-4o@" + other, client);
      const adopted = await fixture.reload();
      expect(adopted.inferenceBinding).toEqual({
        version: 1,
        ...binding(other, "user", requirement === "api-key" ? "subscription" : "api-key"),
        authorizationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(adopted.inferenceBinding?.authorizationId).not.toBe(originalBinding?.authorizationId);
    },
  );

  it.for([
    ["explicit default", subscriptionId, platformId, "api-key", "user"],
    ["explicit default", platformId, subscriptionId, "subscription", "user"],
    ["agent schedule", platformId, subscriptionId, "subscription", "user"],
    ["default schedule", platformId, subscriptionId, "subscription", "user"],
    ["denied schedule", platformId, platformId, "api-key", "auto"],
    ["Gmail session", platformId, subscriptionId, "subscription", "user"],
    ["Gmail delivery", platformId, platformId, "api-key", "auto"],
    ["foreign provider", "anthropic:temporary", platformId, "api-key", "auto"],
  ] as const)(
    "captures %s inference (%s -> %s)",
    async ([selection, creator, profileId, requirement, source], { fixture }) => {
      await fixture.setCreator(creator, selection === "foreign provider" ? "anthropic" : "openai");
      const params = createParams();
      let target: Record<string, string> = {};
      if (selection === "explicit default") {
        fixture.setDefaultProfile(profileId);
      } else if (selection.endsWith("schedule")) {
        fixture.setScheduledProfile(
          subscriptionId,
          selection === "default schedule" ? "default" : "agent",
          selection !== "denied schedule",
        );
      } else if (selection.startsWith("Gmail")) {
        fixture.setGmailProfile(subscriptionId);
        target =
          selection === "Gmail session"
            ? { sessionTarget: "session:agent:main:hook:gmail:synthetic" }
            : { sessionKey: "agent:main:hook:gmail:synthetic" };
      }
      await fixture.invoke("cron.add", { ...params, ...target }, creatorClient());
      const created = await fixture.reload();
      expect(created.payload).not.toHaveProperty("model");
      expect(created.inferenceBinding).toMatchObject(binding(profileId, source, requirement));
    },
  );

  it.for([
    { target: "isolated", explicitModel: false, profileId: subscriptionId },
    { target: "current", explicitModel: false, profileId: subscriptionId },
    { target: "session:agent:main:scheduled-target", explicitModel: false, profileId: platformId },
    {
      target: "session:agent:main:scheduled-target",
      explicitModel: true,
      profileId: subscriptionId,
    },
  ])(
    "uses execution overrides only for $target (explicit model: $explicitModel)",
    async ({ target, explicitModel, profileId }, { fixture }) => {
      await fixture.setCreator(platformId, "openai", "gpt-4.1");
      fixture.setScheduledProfile(subscriptionId, "default", true);
      await upsertSessionEntryCore(
        { sessionKey: "agent:main:scheduled-target", agentId: "main" },
        {
          sessionId: "synthetic-scheduled-target",
          updatedAt: 1,
          providerOverride: "openai",
          modelOverride: "gpt-4.1",
        },
      );
      await fixture.invoke(
        "cron.add",
        modelParams(explicitModel ? "openai/gpt-4o@" + subscriptionId : undefined, target),
        createCronCallerClient("main", undefined, sessionKey),
      );
      expect((await fixture.reload()).inferenceBinding).toMatchObject({
        provider: "openai",
        profileId,
        authRequirement: profileId === platformId ? "api-key" : "subscription",
      });
    },
  );

  it("replaces a host binding when a native creator adopts the job", async ({ fixture }) => {
    await fixture.setCreator(platformId);
    const client = creatorClient();
    await fixture.invoke("cron.add", createParams(), client);
    const created = await fixture.reload();
    expect(created.inferenceBinding).toMatchObject({ profileId: platformId });
    const authority = nativeAuthority;
    using _ = captureAuthority(client, authority);
    await fixture.invoke(
      "cron.update",
      {
        id: created.id,
        patch: {
          payload: {
            kind: "agentTurn",
            message: "Adopt with native inference",
            model: "openai/gpt-4o@openai:missing-native-only",
            toolsAllow: [],
          },
        },
      },
      client,
    );
    const adopted = await fixture.reload();
    expect(adopted.runtimeAuthority).toEqual(authority);
    expect(adopted.inferenceBinding).toBeUndefined();
  });

  it.for([true, false])(
    "uses captured runtime authority or binds the creator when capture is empty (payload: %s)",
    async (hasPayload, { fixture }) => {
      await fixture.setCreator(platformId);
      const authority = hasPayload ? nativeAuthority : undefined;
      const client = creatorClient();
      using _ = captureAuthority(client, authority);
      await fixture.invoke("cron.add", createParams(), client);
      const created = await fixture.reload();
      expect(created.runtimeAuthority).toEqual(authority);
      if (hasPayload) {
        expect(created.inferenceBinding).toBeUndefined();
        // Existing native ownership must also win over later explicit host-account edits.
        await updateModel(fixture, created.id, "openai/gpt-4o@" + subscriptionId);
        const updated = await fixture.reload();
        expect(updated.runtimeAuthority).toEqual(authority);
        expect(updated.inferenceBinding).toBeUndefined();
      } else {
        expect(created.inferenceBinding).toMatchObject({
          profileId: platformId,
          authRequirement: "api-key",
          source: "auto",
        });
        await fixture.changeDefaults(subscriptionId);
        expect(await fixture.resolveAuth(created.inferenceBinding!)).toMatchObject({
          profileId: platformId,
          mode: "api-key",
          apiKey: "synthetic-platform-key",
        });
      }
    },
  );
});
