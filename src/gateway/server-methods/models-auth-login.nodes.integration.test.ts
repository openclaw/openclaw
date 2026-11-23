import { expect, it } from "vitest";
import type { WizardNextResult } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { writeCatalogPlugin } from "./models-catalog-fixture.test-support.js";
import {
  createModelsTestState,
  modelsTestConfig,
  startModelsGateway,
} from "./models-integration.test-support.js";

const provider = "node-login-fixture";
const token = "node-login-synthetic-gateway-token";

// credentialOnly: false takes the app-guided setup activation branch instead of the login wizard.
it.for([true, false])(
  "models.authLogin gives provider sign-in the Gateway node runtime (credentialOnly: %s)",
  async (credentialOnly) => {
    await using state = await createModelsTestState("node-login", { layout: "state-only" });
    const pluginPath = await writeCatalogPlugin(
      state,
      provider,
      `module.exports = {
    id: ${JSON.stringify(provider)},
    register(api) { api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Node login fixture",
      auth: [{ id: "oauth", label: "Fixture account", kind: "oauth", async run(ctx) {
        const listed = await ctx.nodes.list({ connected: true });
        const invoked = await ctx.nodes
          .invoke({ nodeId: "absent-node", command: "system.which", params: { bins: ["sh"] } })
          .then(() => "invoked", (error) => String(error?.message ?? error));
        await ctx.prompter.note(JSON.stringify({ nodes: listed.nodes, invoked }), "Node access");
        return { profiles: [{ profileId: ${JSON.stringify(`${provider}:owner`)}, credential: {
          type: "api_key", provider: ${JSON.stringify(provider)}, key: "synthetic-node-login-key",
        } }] };
      } }],
    }); },
  };`,
      {
        providerAuthChoices: [
          {
            provider,
            method: "oauth",
            choiceId: "fixture-oauth",
            choiceLabel: "Fixture account",
            appGuidedAuth: "oauth",
            credentialOnly,
          },
        ],
      },
    );
    const cfg = modelsTestConfig(state, token, {
      plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
      models: { catalogRefresh: { enabled: false } },
    });
    await state.writeConfig(cfg);
    await using gateway = await startModelsGateway(state, cfg, token);
    const { client } = gateway;
    await gateway.server.startupSettled;

    await client.request("models.authLogin", {
      sessionId: "node-login",
      agentId: "main",
      authChoice: `${provider}/fixture-oauth`,
    });
    const notes: string[] = [];
    let wizard = await client.request<WizardNextResult>("wizard.next", { sessionId: "node-login" });
    while (!wizard.done) {
      const step = wizard.step;
      if (step?.type === "note" && step.title === "Node access") {
        notes.push(step.message ?? "");
      }
      wizard = await client.request<WizardNextResult>("wizard.next", {
        sessionId: "node-login",
        ...(step && step.executor !== "gateway" && step.type !== "progress"
          ? { answer: { stepId: step.id, value: step.type === "confirm" ? true : null } }
          : {}),
      });
    }

    if (credentialOnly) {
      expect(wizard.status, wizard.error).toBe("done");
    }
    // The handle reaches the Gateway's node.invoke owner, which rejects an absent node.
    expect(notes.map((note) => JSON.parse(note))).toEqual([
      { nodes: [], invoked: expect.stringMatching(/^node (not connected|pairing changed)/) },
    ]);
  },
);
