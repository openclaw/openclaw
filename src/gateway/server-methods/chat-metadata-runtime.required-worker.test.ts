import { expect, test } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";

const config: OpenClawConfig = {
  agents: { defaults: { model: { primary: "openai/worker-model" } }, entries: { main: {} } },
  cloudWorkers: {
    requiredProfile: "dedicated",
    profiles: {
      dedicated: { provider: "device", settings: { device: "paired", inference: "worker" } },
    },
  },
};
const models = ["worker-model", "other-model"].map((id) => ({
  id,
  name: id,
  provider: "openai",
  available: false,
  unavailableReason: "missing-auth",
}));

async function createPreparedChatMetadataHarness(cfg: OpenClawConfig) {
  const metadataSnapshot = await resolvePluginMetadataSnapshotAsync({ config: cfg });
  const harness = createChatMetadataHarness(cfg);
  const runtime = harness.runtime;
  return {
    ...harness,
    runtime: {
      ...runtime,
      read: (...args: Parameters<typeof runtime.read>) =>
        withPluginMetadataSnapshotScope(metadataSnapshot, () => runtime.read(...args), {
          config: cfg,
        }),
      readStartup: (...args: Parameters<typeof runtime.readStartup>) =>
        withPluginMetadataSnapshotScope(metadataSnapshot, () => runtime.readStartup(...args), {
          config: cfg,
        }),
    },
  };
}

test("required worker chat metadata admits cold main and bookmarked sessions without Gateway auth", async () => {
  const harness = await createPreparedChatMetadataHarness(config);
  harness.buildProjection.mockResolvedValue({ modelCatalog: models, models });
  try {
    await harness.runtime.refresh();
    for (const scope of [
      { agentId: "main", sessionKey: "agent:main:main" },
      { agentId: "main", sessionKey: "agent:main:bookmark", sessionEntry: { sessionId: "saved" } },
    ]) {
      const metadata = await harness.runtime.read(scope);
      expect(metadata.models?.[0]).not.toHaveProperty("unavailableReason");
      expect(metadata.models?.[0]).not.toHaveProperty("available");
      expect(metadata.models?.[1]).toEqual(models[1]);
      expect((await harness.runtime.readStartup(scope))?.metadata).toEqual(metadata);
    }
    expect((await harness.runtime.read({ agentId: "main" })).models).toEqual(models);
    expect(
      (
        await harness.runtime.read({
          agentId: "main",
          sessionKey: "agent:main:pinned",
          sessionEntry: { agentRuntimeOverride: "codex" },
        })
      ).models,
    ).toEqual(models);
    expect(models[0]).toHaveProperty("unavailableReason", "missing-auth");
  } finally {
    await harness.runtime.stop();
  }
});

test.each(["missing", "gateway", "invalid-provider", "no-device", "optional"])(
  "keeps Gateway credentials when required worker intent is not usable (%s)",
  async (kind) => {
    const cfg = structuredClone(config);
    if (kind === "missing") {
      cfg.cloudWorkers!.profiles = {};
    }
    if (kind === "gateway") {
      cfg.cloudWorkers!.profiles!.dedicated!.settings!.inference = "gateway";
    }
    if (kind === "invalid-provider") {
      cfg.cloudWorkers!.profiles!.dedicated!.provider = "external";
    }
    if (kind === "no-device") {
      cfg.cloudWorkers!.profiles!.dedicated!.settings!.device = "";
    }
    if (kind === "optional") {
      delete cfg.cloudWorkers!.requiredProfile;
    }
    const harness = await createPreparedChatMetadataHarness(cfg);
    harness.buildProjection.mockResolvedValue({ modelCatalog: models, models });
    try {
      await harness.runtime.refresh();
      expect(
        (await harness.runtime.read({ agentId: "main", sessionKey: "agent:main:main" })).models,
      ).toEqual(models);
    } finally {
      await harness.runtime.stop();
    }
  },
);

test("scopes worker metadata to the saved selection and preserves non-auth availability", async () => {
  const harness = await createPreparedChatMetadataHarness(config);
  const cooldown = models.map((model) => ({ ...model, unavailableReason: "cooldown" }));
  harness.buildProjection.mockResolvedValue({ modelCatalog: cooldown, models: cooldown });
  try {
    await harness.runtime.refresh();
    expect(
      (await harness.runtime.read({ agentId: "main", sessionKey: "agent:main:main" })).models,
    ).toEqual(cooldown);
  } finally {
    await harness.runtime.stop();
  }
});

test.each([
  { agentRuntimeOverride: "auto" },
  { agentRuntimeOverride: "default" },
  { agentRuntimeOverride: "openclaw" },
  { agentHarnessId: "codex", modelSelectionLocked: true, agentRuntimeOverride: "openclaw" },
])("retains upstream availability for explicit runtime selection %j", async (sessionEntry) => {
  const harness = await createPreparedChatMetadataHarness(config);
  harness.buildProjection.mockResolvedValue({ modelCatalog: models, models });
  try {
    await harness.runtime.refresh();
    const result = await harness.runtime.read({
      agentId: "main",
      sessionKey: "agent:main:saved",
      sessionEntry,
    });
    // Required placement is intent, not a grant for explicit runtime/account choices.
    // Preserve the clients-stack overlay's explicit-selection checks.
    expect(result.models).toEqual(models);
  } finally {
    await harness.runtime.stop();
  }
});
