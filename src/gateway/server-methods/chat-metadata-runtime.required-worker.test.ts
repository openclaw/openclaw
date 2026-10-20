import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { onTestFinished, expect, test } from "vitest";
import type { ChatMetadataResponse } from "../../../ui/src/lib/chat/chat-metadata-cache.ts";
import {
  beginChatMetadataPublication,
  revalidateChatMetadata,
} from "../../../ui/src/lib/chat/chat-metadata-store.ts";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.ts";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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

async function workerHarness(cfg = config, catalog = models) {
  const harness = createChatMetadataHarness(cfg);
  onTestFinished(() => harness.runtime.stop());
  harness.buildProjection.mockResolvedValue({ modelCatalog: catalog, models: catalog });
  await harness.refresh();
  return harness;
}

test("does not retain startup worker policy across a command-only refresh", async () => {
  const cfg = structuredClone(config);
  const harness = createChatMetadataHarness(cfg);
  onTestFinished(() => harness.runtime.stop());
  const scope = { agentId: "main", sessionKey: "agent:main:main" };
  const client = createTestGatewayClient(async (method, params) => {
    if (method === "chat.startup") {
      return (await harness.startup(scope))?.metadata;
    }
    expect(method).toBe("chat.metadata");
    const ifRevision = asOptionalRecord(params)?.ifRevision;
    return harness.read({
      includeModels: false,
      ifRevision: typeof ifRevision === "string" ? ifRevision : undefined,
    });
  });
  await harness.refresh();
  await harness.read();
  const startup = await client.request<ChatMetadataResponse>("chat.startup", scope);
  const published = beginChatMetadataPublication(client, scope).publish(startup);
  expect(published.requiredWorkerInferenceProfileId).toBe("dedicated");
  delete cfg.cloudWorkers!.requiredProfile;
  const refreshed = await revalidateChatMetadata(client, scope);
  expect(refreshed.commands).toEqual(published.commands);
  expect(refreshed.requiredWorkerInferenceProfileId).toBeUndefined();
});

test("required worker chat metadata admits cold main and bookmarked sessions without Gateway auth", async () => {
  const harness = await workerHarness();
  for (const scope of [
    { agentId: "main", sessionKey: "agent:main:main" },
    { agentId: "main", sessionKey: "agent:main:bookmark", sessionEntry: { sessionId: "saved" } },
  ]) {
    const metadata = await harness.runtime.read(scope);
    expect(metadata.models?.[0]).not.toHaveProperty("unavailableReason");
    expect(metadata.models?.[0]).not.toHaveProperty("available");
    expect(metadata.models?.[1]).toEqual(models[1]);
    expect((await harness.startup(scope))?.metadata).toMatchObject({
      requiredWorkerInferenceProfileId: "dedicated",
    });
  }
  expect((await harness.read()).models).toEqual(models);
  expect(
    (
      await harness.read({
        sessionKey: "agent:main:pinned",
        sessionEntry: { agentRuntimeOverride: "codex" },
      })
    ).models,
  ).toEqual(models);
  expect(models[0]).toHaveProperty("unavailableReason", "missing-auth");
});

test("keeps Gateway credentials when the required worker has no device", async () => {
  const cfg = structuredClone(config);
  cfg.cloudWorkers!.profiles!.dedicated!.settings!.device = "";
  const harness = await workerHarness(cfg);
  expect((await harness.read({ sessionKey: "agent:main:main" })).models).toEqual(models);
});

test("scopes worker metadata to the saved selection and preserves non-auth availability", async () => {
  const cooldown = models.map((model) => ({ ...model, unavailableReason: "cooldown" }));
  const harness = await workerHarness(config, cooldown);
  expect((await harness.read({ sessionKey: "agent:main:main" })).models).toEqual(cooldown);
});

test.each([
  { agentRuntimeOverride: "auto" },
  { agentRuntimeOverride: "default" },
  { agentRuntimeOverride: "openclaw" },
  { agentHarnessId: "codex", modelSelectionLocked: true, agentRuntimeOverride: "openclaw" },
])("retains upstream availability for explicit runtime selection %j", async (sessionEntry) => {
  const harness = await workerHarness();
  const result = await harness.read({
    sessionKey: "agent:main:saved",
    sessionEntry,
  });
  // Required placement does not override explicit runtime/account choices.
  expect(result.models).toEqual(models);
});
