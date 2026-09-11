import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

describe("Doctor model billing route migration", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    { multiagent: false, successor: "gpt-5.6-luna" },
    { multiagent: true, successor: "gpt-5.4-mini" },
  ])(
    "records inherited billing changes once (multiagent: $multiagent)",
    async ({ multiagent, successor }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          auth: {
            profiles: {
              "openai:default": { provider: "openai", mode: "api_key" },
              "openai:chatgpt-default": { provider: "openai", mode: "oauth" },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-completions",
                models: [{ id: "gpt-4o-mini", name: "Heartbeat", input: ["text"] }],
              },
            },
          },
          agents: {
            defaults: {
              model: "openai/gpt-5.4",
              models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
              heartbeat: { model: "openai/gpt-4o-mini" },
              subagents: { model: "openai/gpt-4o-mini" },
            },
            ...(multiagent ? { ownership: "explicit" } : {}),
            entries: multiagent
              ? {
                  main: { heartbeat: {} },
                  metered: {
                    heartbeat: { model: "openai/gpt-5.4" },
                    subagents: { model: "openai/gpt-5.4" },
                    models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
                  },
                }
              : { main: {} },
          },
          gateway: {
            mode: "local",
            port: 19473,
            auth: { mode: "token", token: "synthetic-gateway-token" },
          },
        });
        const authDir = path.join(path.dirname(configPath), "agents", "main", "agent");
        await fs.mkdir(authDir, { recursive: true });
        await fs.writeFile(
          path.join(authDir, "auth-profiles.json"),
          JSON.stringify({
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key: "synthetic-api-key" },
              "openai:chatgpt-default": {
                type: "oauth",
                provider: "openai",
                access: "synthetic-oauth-access",
                refresh: "synthetic-oauth-refresh",
                expires: Date.now() + 3_600_000,
              },
            },
          }),
        );
        const ctx = await prepareDoctorContext(configPath);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
        const expectedRoute = `openai/gpt-4o-mini via metered API-key profile openai:default -> openai/${successor} via subscription/OAuth profile openai:chatgpt-default.`;
        expect(ctx.updateWarnings).toEqual([
          expect.stringContaining(
            `Billing route changed for agents.defaults.heartbeat.model (agent main): ${expectedRoute}`,
          ),
          expect.stringContaining(
            `Billing route changed for agents.defaults.subagents.model (agent main): ${expectedRoute}`,
          ),
        ]);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
        expect(ctx.updateWarnings).toHaveLength(2);
        const repeated = await prepareDoctorContext(configPath);
        await runWriteConfigHealth(repeated, { runPostWriteRepairs: false });
        expect(repeated.updateWarnings ?? []).toEqual([]);
      });
    },
  );
});
