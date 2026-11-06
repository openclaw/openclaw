import { beforeEach, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import {
  SESSION,
  CREATOR,
  cfg as baseCfg,
  stateDir,
  admission,
  inRun,
  createCronFixture,
  createCreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";

// Node inventory is unrelated to causal creator capture at the Cron commit boundary.
vi.mock("../../agents/node-exec-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/node-exec-availability.js")>()),
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

installRequesterCronAuthorityTestHooks({
  ...CREATOR,
  delegatedBy: { type: "human", source: "profile", id: "historical-human" },
});
let config: OpenClawConfig;
beforeEach(async () => {
  config = {
    ...baseCfg,
    agents: { ...baseCfg.agents, defaults: { model: "openai/gpt-4.1", workspace: stateDir } },
    tools: { allow: [AUTOMATIONS_TOOL_NAME] },
  };
  setRuntimeConfigSnapshot(config);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("OPENAI_OAUTH_TOKEN", undefined);
  await persistAuthProfileBatch({
    stateDir,
    profiles: [
      {
        profileId: "openai:automation-test",
        credential: { type: "api_key", provider: "openai", key: "synthetic-automation-test-key" },
      },
    ],
  });
});

it.each([
  ["causal human", "selected-user", "causal-human"],
  ["no human requester", undefined, undefined],
  ["explicit no-human origin", "selected-user", null],
] as const)(
  "attributes new cron to %s, never the session's historical human",
  async (_name, operatorProfileId, delegatedCreatorProfileId) => {
    const fixture = createCronFixture(undefined, config);
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
    client.internal = { isLocalClient: true };
    const runId = "attributed-cron";
    const origin = { sessionKey: SESSION, operatorProfileId, delegatedCreatorProfileId };
    await inRun(
      runId,
      admission(runId, client),
      async (_identity, admitted, creator) => {
        bindGatewayContextResolver(admitted, () => fixture.context);
        try {
          const tools = await createCreatorTransportTools({
            transport: "embedded",
            config,
            admitted,
            creator,
            requesterOrigin: origin,
            senderIsOwner: true,
          });
          await tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "add",
            job: {
              name: "Attributed cron",
              enabled: false,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "current",
              payload: { kind: "agentTurn", message: "Check status" },
              delivery: { mode: "none" },
            },
          });
          const [job] = await fixture.read();
          const delegatedBy = delegatedCreatorProfileId
            ? { type: "human", source: "profile", id: delegatedCreatorProfileId }
            : { type: "agent", id: "main" };
          expect(job?.createdActor).toEqual({ ...CREATOR, delegatedBy });
          expect(job?.owner).toMatchObject({ agentId: "main", sessionKey: SESSION });
          await tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "update",
            jobId: job!.id,
            job: { name: "Updated cron" },
          });
          expect((await fixture.read())[0]?.createdActor).toEqual(job?.createdActor);
        } finally {
          clearGatewayContextResolver(admitted);
        }
      },
      undefined,
      origin,
    );
  },
);
