import { describe, expect, it } from "vitest";
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

describe("cron handler inference binding persistence", () => {
  it("keeps native Codex inference unbound without a Gateway account", async () => {
    await withFixture(async (fixture) => {
      await fixture.useUnstoredCredential("openai");
      fixture.setCodexRuntime();
      await fixture.invoke("cron.add", createParams());
      const job = await fixture.reload();
      expect(job.enabled).toBe(false);
      expect(job.inferenceBinding).toBeUndefined();
    });
  });

  it.each([
    { name: "builtin runtime setup hint", runtime: "openclaw", error: "stored inference account" },
    { name: "unavailable Codex runtime", registered: false, error: "codex" },
    { name: "unsupported Codex runtime", supported: false, error: "does not support" },
  ])("rejects $name without persisting a job", async ({ name: _name, error, ...runtime }) => {
    await withFixture(async (fixture) => {
      await fixture.useUnstoredCredential("openai");
      fixture.setCodexRuntime(runtime);
      const failure = await fixture.invoke("cron.add", createParams(), null, {
        expectedSuccess: false,
      });
      expect(failure).toMatchObject({ message: expect.stringContaining(error) });
      expect(await fixture.status()).toMatchObject({ jobs: 0 });
    });
  });

  it("does not replace an explicit missing Codex account with native auth", async () => {
    await withFixture(async (fixture) => {
      await fixture.useUnstoredCredential("openai");
      fixture.setCodexRuntime();
      const params = createParams();
      const failure = await fixture.invoke(
        "cron.add",
        {
          ...params,
          payload: { ...params.payload, model: "codex/openai-compatible/gpt-5.4@missing-account" },
        },
        null,
        { expectedSuccess: false },
      );
      expect(failure).toMatchObject({ message: expect.stringContaining("missing-account") });
      expect(await fixture.status()).toMatchObject({ jobs: 0 });
    });
  });

  it.each(["absent", "ambient"] as const)(
    "keeps required worker inference unbound with %s Gateway credentials",
    async (credentials) => {
      await withFixture(async (fixture) => {
        if (credentials === "absent") {
          await fixture.useUnstoredCredential("openai");
        }
        fixture.setWorkerInference(true, "worker");
        await fixture.invoke("cron.add", createParams());
        const job = await fixture.reload();
        expect(job.enabled).toBe(false);
        expect(job.inferenceBinding).toBeUndefined();
      });
    },
  );

  it.each([
    { name: "optional worker", required: false, inference: "worker" },
    { name: "required Gateway inference", required: true, inference: "gateway" },
  ] as const)("retains host credential validation for $name", async ({ required, inference }) => {
    await withFixture(async (fixture) => {
      await fixture.useUnstoredCredential("openai");
      fixture.setWorkerInference(required, inference);
      const error = await fixture.invoke("cron.add", createParams(), null, {
        expectedSuccess: false,
      });
      expect(error).toMatchObject({
        message: expect.stringContaining("No route-compatible authentication source"),
      });
      expect(await fixture.status()).toMatchObject({ jobs: 0 });
    });
  });

  it.each(["model", "creator", "default"] as const)(
    "validates a selected %s account even with required worker inference",
    async (selection) => {
      await withFixture(async (fixture) => {
        await fixture.useUnstoredCredential("openai");
        fixture.setWorkerInference(true, "worker");
        if (selection === "creator") {
          await fixture.setCreator(platformId);
        } else if (selection === "default") {
          fixture.setDefaultProfile(platformId);
        }
        const model = selection === "model" ? "openai/gpt-4.1@" + platformId : "openai/gpt-4.1";
        const params = createParams();
        const error = await fixture.invoke(
          "cron.add",
          {
            ...params,
            payload: {
              ...params.payload,
              ...(selection === "creator" ? {} : { model }),
            },
          },
          selection === "creator" ? createCronCallerClient("main", undefined, sessionKey) : null,
          { expectedSuccess: false },
        );
        expect(error).toMatchObject({ message: expect.stringContaining(platformId) });
        expect(await fixture.status()).toMatchObject({ jobs: 0 });
      });
    },
  );

  it.each(["environment", "configuration"] as const)(
    "creates an unbound job on a %s key, the same rule its runs follow",
    async (source) => {
      await withFixture(async (fixture) => {
        const key = "synthetic-direct-key";
        await fixture.useUnstoredCredential("openai", source === "configuration" ? key : undefined);
        await withEnvAsync(
          { OPENAI_API_KEY: source === "environment" ? key : undefined },
          async () => {
            await fixture.invoke("cron.add", createParams());
            expect((await fixture.reload()).inferenceBinding).toBeUndefined();
          },
        );
      });
    },
  );

  it("allows configured credentialless local inference without inventing an account binding", async () => {
    await withFixture(async (fixture) => {
      await fixture.useUnstoredCredential("ollama");
      await fixture.invoke("cron.add", createParams());
      expect((await fixture.reload()).inferenceBinding).toBeUndefined();
    });
  });

  it.each(["add", "update"] as const)(
    "rejects credential replacement after capture before %s commit",
    async (method) => {
      await withFixture(async (fixture) => {
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
      });
    },
  );

  it("requires the personal owner for explicit creation and account adoption", async () => {
    await withFixture(async (fixture) => {
      const personal = await fixture.personalAccount();
      const params = {
        ...createParams(),
        payload: {
          ...createParams().payload,
          model: "openai/gpt-4.1@" + personal.profileId,
        },
      };
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
  });

  it("inherits a trusted creator's personal selection without turning it into a new user pin", async () => {
    await withFixture(async (fixture) => {
      const personal = await fixture.personalAccount();
      await fixture.setCreator(personal.profileId);
      await fixture.invoke(
        "cron.add",
        createParams(),
        createCronCallerClient("main", undefined, sessionKey),
      );
      expect((await fixture.reload()).inferenceBinding).toMatchObject({
        profileId: personal.profileId,
        source: "auto",
        authRequirement: "api-key",
      });
    });
  });

  it("rejects an agent move that changes credential ownership unless an account is adopted", async () => {
    await withFixture(async (fixture) => {
      await fixture.invoke("cron.add", createParams());
      const created = await fixture.reload();
      fixture.addAgent("secondary");
      await fixture.invoke("cron.update", { id: created.id, patch: { agentId: "main" } });
      expect((await fixture.reload()).inferenceBinding).toEqual(created.inferenceBinding);
      await fixture.invoke(
        "cron.update",
        { id: created.id, patch: { agentId: "secondary" } },
        null,
        { expectedSuccess: false },
      );
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
  });

  it("adopts an explicit account on an aliased model but not on a plain alias", async () => {
    await withFixture(async (fixture) => {
      fixture.setAlias();
      await fixture.invoke("cron.add", createParams());
      const created = await fixture.reload();
      await fixture.invoke("cron.update", {
        id: created.id,
        patch: {
          payload: { kind: "agentTurn", model: "synthetic-alias@" + subscriptionId },
        },
      });
      const adopted = await fixture.reload();
      expect(adopted.inferenceBinding).toMatchObject({ profileId: subscriptionId, source: "user" });
      await fixture.invoke("cron.update", {
        id: created.id,
        patch: {
          payload: { kind: "agentTurn", model: "synthetic-alias" },
        },
      });
      expect((await fixture.reload()).inferenceBinding).toEqual(adopted.inferenceBinding);
    });
  });
  it.each([
    { profileId: platformId, other: subscriptionId, requirement: "api-key" },
    { profileId: subscriptionId, other: platformId, requirement: "subscription" },
  ])(
    "keeps the creator's $requirement binding until an explicit model@profile update",
    async ({ profileId, other, requirement }) => {
      await withFixture(async (fixture) => {
        await fixture.setCreator(profileId);
        const client = createCronCallerClient("main", undefined, sessionKey);
        await fixture.invoke("cron.add", createParams(), client);
        const created = await fixture.reload();
        expect(created.inferenceBinding).toEqual({
          version: 1,
          provider: "openai",
          profileId,
          authorizationId: expect.stringMatching(/^[a-f0-9]{64}$/),
          authRequirement: requirement,
          source: "auto",
        });
        const originalBinding = created.inferenceBinding;
        await fixture.changeDefaults(other);
        await fixture.setCreator(other);
        await fixture.invoke(
          "cron.update",
          {
            id: created.id,
            patch: { payload: { kind: "agentTurn", model: "openai/gpt-4o" } },
          },
          client,
        );
        const preserved = await fixture.reload();
        expect(preserved.payload).toMatchObject({ model: "openai/gpt-4o" });
        expect(preserved.inferenceBinding).toEqual(originalBinding);
        await fixture.invoke("cron.get", { id: created.id });
        await fixture.invoke("cron.list", {
          includeDisabled: true,
          includeDeliveryPreviews: false,
        });

        await fixture.invoke(
          "cron.update",
          {
            id: created.id,
            patch: { payload: { kind: "agentTurn", model: "openai/gpt-4o@" + other } },
          },
          client,
        );
        const adopted = await fixture.reload();
        expect(adopted.inferenceBinding).toEqual({
          version: 1,
          provider: "openai",
          profileId: other,
          authorizationId: expect.stringMatching(/^[a-f0-9]{64}$/),
          authRequirement: requirement === "api-key" ? "subscription" : "api-key",
          source: "user",
        });
        expect(adopted.inferenceBinding?.authorizationId).not.toBe(
          originalBinding?.authorizationId,
        );
      });
    },
  );

  it.each([
    { profileId: platformId, creator: subscriptionId, requirement: "api-key" },
    { profileId: subscriptionId, creator: platformId, requirement: "subscription" },
  ])(
    "captures an explicit default $requirement profile before the creator auto selection",
    async ({ profileId, creator, requirement }) => {
      await withFixture(async (fixture) => {
        await fixture.setCreator(creator);
        fixture.setDefaultProfile(profileId);
        await fixture.invoke(
          "cron.add",
          createParams(),
          createCronCallerClient("main", undefined, sessionKey),
        );
        const created = await fixture.reload();
        expect(created.inferenceBinding).toMatchObject({
          provider: "openai",
          profileId,
          authRequirement: requirement,
          source: "user",
        });
      });
    },
  );

  it.each([
    { scope: "agent", allowed: true },
    { scope: "default", allowed: true },
    { scope: "agent", allowed: false },
  ] as const)(
    "records the effective account for an $scope scheduled model (allowed: $allowed)",
    async ({ scope, allowed }) => {
      await withFixture(async (fixture) => {
        await fixture.setCreator(platformId);
        fixture.setScheduledProfile(subscriptionId, scope, allowed);
        await fixture.invoke(
          "cron.add",
          createParams(),
          createCronCallerClient("main", undefined, sessionKey),
        );
        const created = await fixture.reload();
        expect(created.payload).not.toHaveProperty("model");
        expect(created.inferenceBinding).toMatchObject({
          provider: "openai",
          profileId: allowed ? subscriptionId : platformId,
          authRequirement: allowed ? "subscription" : "api-key",
          source: allowed ? "user" : "auto",
        });
      });
    },
  );

  it.each([
    { source: "session", isGmailHook: true },
    { source: "delivery-only", isGmailHook: false },
  ] as const)(
    "captures the execution account for $source Gmail provenance",
    async ({ source, isGmailHook }) => {
      await withFixture(async (fixture) => {
        await fixture.setCreator(platformId);
        fixture.setGmailProfile(subscriptionId);
        const params = {
          ...createParams(),
          ...(source === "session"
            ? { sessionTarget: "session:agent:main:hook:gmail:synthetic" }
            : { sessionKey: "agent:main:hook:gmail:synthetic" }),
        };
        await fixture.invoke(
          "cron.add",
          params,
          createCronCallerClient("main", undefined, sessionKey),
        );
        const created = await fixture.reload();
        expect(created.payload).not.toHaveProperty("model");
        expect(created.inferenceBinding).toMatchObject({
          provider: "openai",
          profileId: isGmailHook ? subscriptionId : platformId,
          authRequirement: isGmailHook ? "subscription" : "api-key",
          source: isGmailHook ? "user" : "auto",
        });
      });
    },
  );

  it("captures the effective job default instead of an unrelated creator provider", async () => {
    await withFixture(async (fixture) => {
      await fixture.setCreator("anthropic:temporary", "anthropic");
      await fixture.invoke(
        "cron.add",
        createParams(),
        createCronCallerClient("main", undefined, sessionKey),
      );
      const created = await fixture.reload();
      expect(created.payload).not.toHaveProperty("model");
      expect(created.inferenceBinding).toMatchObject({
        provider: "openai",
        profileId: platformId,
        authRequirement: "api-key",
        source: "auto",
      });
    });
  });

  it.each([
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
    async ({ target, explicitModel, profileId }) => {
      await withFixture(async (fixture) => {
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
        const params = createParams();
        await fixture.invoke(
          "cron.add",
          {
            ...params,
            sessionTarget: target,
            payload: {
              ...params.payload,
              ...(explicitModel ? { model: "openai/gpt-4o@" + subscriptionId } : {}),
            },
          },
          createCronCallerClient("main", undefined, sessionKey),
        );
        expect((await fixture.reload()).inferenceBinding).toMatchObject({
          provider: "openai",
          profileId,
          authRequirement: profileId === platformId ? "api-key" : "subscription",
        });
      });
    },
  );

  it("replaces a host binding when a native creator adopts the job", async () => {
    await withFixture(async (fixture) => {
      await fixture.setCreator(platformId);
      const client = createCronCallerClient("main", undefined, sessionKey);
      await fixture.invoke("cron.add", createParams(), client);
      const created = await fixture.reload();
      expect(created.inferenceBinding).toMatchObject({ profileId: platformId });
      const authority: CronRuntimeAuthority = {
        version: 1,
        runtimeId: "synthetic-native",
        namespace: "synthetic.inference",
        payload: { account: "synthetic-native-account" },
      };
      const identity = client.internal!.agentRuntimeIdentity!;
      const scope = createCronCreatorAuthorityRunScope(identity.operationalRunInstance.runId);
      identity.cronToolsAllowCapture = "final-executable-surface";
      identity.cronCreatorAuthorityGrant = mintCronCreatorAuthorityGrant(
        scope,
        undefined,
        authority,
      );
      try {
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
      } finally {
        revokeCronCreatorAuthorityRunScope(scope);
      }
    });
  });

  it.each([true, false])(
    "uses captured runtime authority or binds the creator when capture is empty (payload: %s)",
    async (hasPayload) => {
      await withFixture(async (fixture) => {
        await fixture.setCreator(platformId);
        const authority: CronRuntimeAuthority | undefined = hasPayload
          ? {
              version: 1,
              runtimeId: "synthetic-native",
              namespace: "synthetic.inference",
              payload: { account: "synthetic-native-account" },
            }
          : undefined;
        const client = createCronCallerClient("main", undefined, sessionKey);
        const identity = client.internal!.agentRuntimeIdentity!;
        const scope = createCronCreatorAuthorityRunScope(identity.operationalRunInstance.runId);
        identity.cronToolsAllowCapture = "final-executable-surface";
        identity.cronCreatorAuthorityGrant = mintCronCreatorAuthorityGrant(
          scope,
          undefined,
          authority,
        );
        try {
          await fixture.invoke("cron.add", createParams(), client);
          const created = await fixture.reload();
          expect(created.runtimeAuthority).toEqual(authority);
          if (hasPayload) {
            expect(created.inferenceBinding).toBeUndefined();
            // Existing native ownership must also win over later explicit host-account edits.
            await fixture.invoke("cron.update", {
              id: created.id,
              patch: { payload: { kind: "agentTurn", model: "openai/gpt-4o@" + subscriptionId } },
            });
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
        } finally {
          revokeCronCreatorAuthorityRunScope(scope);
        }
      });
    },
  );
});
