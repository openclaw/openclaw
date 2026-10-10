import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { bindProviderRenameAuthProfiles } from "./provider-rename-auth.js";
import {
  applyProviderRenames,
  rewriteProviderModelRef,
  type ProviderRename,
} from "./provider-rename.js";

const declaration: ProviderRename = {
  from: "ollama",
  to: "ollama-cloud",
  baseUrl: "https://ollama.com",
};

const cases = [
  {
    name: "no profiles",
    shared: [],
    alpha: [],
    beta: [],
    alphaSelected: undefined,
    betaSelected: undefined,
  },
  {
    name: "sole local profiles",
    shared: [],
    alpha: ["ollama-cloud:alpha"],
    beta: ["ollama-cloud:beta"],
    alphaSelected: "ollama-cloud:alpha",
    betaSelected: "ollama-cloud:beta",
  },
  {
    name: "default beats multiple visible profiles",
    shared: ["ollama-cloud:shared"],
    alpha: ["ollama-cloud:alpha", "ollama-cloud:default"],
    beta: ["ollama-cloud:beta"],
    alphaSelected: "ollama-cloud:default",
    betaSelected: undefined,
  },
  {
    name: "ambiguous shared and local profiles",
    shared: ["ollama-cloud:shared"],
    alpha: ["ollama-cloud:alpha"],
    beta: ["ollama-cloud:beta"],
    alphaSelected: undefined,
    betaSelected: undefined,
  },
];

describe("provider rename saved-auth binding", () => {
  it.each(cases)(
    "uses only each owning agent's saved profiles without modifying credentials: $name",
    async ({ shared, alpha, beta, alphaSelected, betaSelected }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const store = (ids: string[]): AuthProfileStore => ({
          version: 1,
          profiles: {
            "ollama:default": { type: "api_key", provider: "ollama", key: "synthetic-old-key" },
            ...Object.fromEntries(
              ids.map((id) => [
                id,
                {
                  type: "api_key" as const,
                  provider: "ollama-cloud",
                  key: "synthetic-target-key",
                },
              ]),
            ),
          },
        });
        await state.writeAuthProfiles(store(shared));
        await state.writeAuthProfiles(store(alpha), "alpha");
        await state.writeAuthProfiles(store(beta), "beta");
        const model = (own: string, other: string) => ({
          primary: "ollama/model@ollama:default",
          fallbacks: [
            `ollama/model@ollama-cloud:${own}`,
            `ollama/model@ollama-cloud:${other}`,
            "ollama/model@ollama-cloud:shared",
          ],
        });
        const config: OpenClawConfig = {
          models: { providers: { ollama: { baseUrl: "https://ollama.com", models: [] } } },
          agents: {
            defaults: { systemAgent: { agentId: "alpha" }, model: model("alpha", "beta") },
            entries: {
              alpha: { model: model("alpha", "beta") },
              beta: { model: model("beta", "alpha") },
            },
          },
          // Metadata alone cannot authorize a profile pin.
          auth: {
            profiles: {
              "ollama-cloud:metadata-only": { provider: "ollama-cloud", mode: "api_key" },
            },
          },
        };
        Object.assign(config, { model: "ollama/global@ollama:default" });
        const before = new Map(
          fs
            .readdirSync(state.stateDir, { recursive: true, encoding: "utf8" })
            .filter((name) => name.endsWith(".sqlite"))
            .map((name) => [name, fs.readFileSync(path.join(state.stateDir, name))]),
        );
        const bound = bindProviderRenameAuthProfiles(config, [declaration], state.env);
        expect(bound).toMatchObject([
          {
            ...declaration,
            targetAuthProfileIds: [...shared, ...alpha],
            targetAuthProfileId: alphaSelected,
          },
        ]);
        const expectedRef = (selected: string | undefined) =>
          selected ? `ollama-cloud/model@${selected}` : "ollama-cloud/model";
        const expectedModel = (own: string, ids: string[], selected: string | undefined) => ({
          primary: expectedRef(selected),
          fallbacks: [
            expectedRef(ids.includes(`ollama-cloud:${own}`) ? `ollama-cloud:${own}` : selected),
            expectedRef(selected),
            expectedRef(shared.includes("ollama-cloud:shared") ? "ollama-cloud:shared" : selected),
          ],
        });
        const result = applyProviderRenames(config, bound);
        expect(result.config.agents?.defaults?.model).toEqual(
          expectedModel("alpha", alpha, alphaSelected),
        );
        expect(result.config.agents?.entries).toEqual({
          alpha: { model: expectedModel("alpha", alpha, alphaSelected) },
          beta: { model: expectedModel("beta", beta, betaSelected) },
        });
        expect(result.config).toMatchObject({
          model: alphaSelected ? `ollama-cloud/global@${alphaSelected}` : "ollama-cloud/global",
        });
        expect(result.config.auth).toEqual(config.auth);
        expect(rewriteProviderModelRef("ollama/model@ollama:default", bound)).toBe(
          expectedRef(alphaSelected),
        );
        expect(rewriteProviderModelRef("ollama/model@ollama-cloud:alpha", bound, "unlisted")).toBe(
          expectedRef(shared.length === 1 ? shared[0] : undefined),
        );
        for (const [name, bytes] of before) {
          expect(fs.readFileSync(path.join(state.stateDir, name))).toEqual(bytes);
        }
      });
    },
  );

  it("does not create stores or trust config metadata when credentials are absent", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const before = fs.readdirSync(state.stateDir, { recursive: true });
      const config: OpenClawConfig = {
        auth: {
          profiles: { "ollama-cloud:default": { provider: "ollama-cloud", mode: "api_key" } },
        },
      };
      expect(bindProviderRenameAuthProfiles(config, [declaration], state.env)).toMatchObject([
        { ...declaration, targetAuthProfileIds: [], targetAuthProfileId: undefined },
      ]);
      expect(fs.readdirSync(state.stateDir, { recursive: true })).toEqual(before);
    });
  });
});
