import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
} from "../config/io.audit.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { createTestModelDefinition } from "./test-runtime-config-helpers.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

it("strips an audit-proven generated fallback row and rematerializes catalog capabilities", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      async () => {
        const model = createTestModelDefinition("gpt-5.6-sol", {
          contextWindow: 272_000,
          contextTokens: 272_000,
          maxTokens: 8192,
          api: "openai-chatgpt-responses",
        });
        const provider = {
          api: model.api,
          baseUrl: "https://chatgpt.com/backend-api/codex",
          models: [model],
        };
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          models: { providers: { openai: provider } },
        });
        const before = await readConfigFileSnapshot();
        const auditBase = createConfigWriteAuditRecordBase({
          configPath,
          env: process.env,
          existsBefore: true,
          previousHash: "before-materialization",
          nextHash: before.hash!,
          previousBytes: 100,
          nextBytes: Buffer.byteLength(before.raw ?? "", "utf-8"),
          previousMetadata: {
            dev: null,
            ino: null,
            mode: null,
            nlink: null,
            uid: null,
            gid: null,
          },
          changedPathCount: 96,
          changedPaths: ["reasoning", "input", "cost", "maxTokens"].map(
            (field) => `models.providers.openai.models[0].${field}`,
          ),
          origin: "doctor",
          hasMetaBefore: true,
          hasMetaAfter: true,
          gatewayModeBefore: "local",
          gatewayModeAfter: "local",
          suspicious: [],
          processInfo: {
            pid: 1,
            ppid: 0,
            cwd: "/tmp",
            argv: ["openclaw", "update", "finalize", "--yes", "--channel", "dev"],
            execArgv: [],
          },
        });
        await appendConfigAuditRecord({
          env: process.env,
          homedir: () => home,
          record: finalizeConfigWriteAuditRecord({ base: auditBase, result: "rename" }),
        });

        await using ctx = await prepareDoctorContext(configPath);
        await runInitialConfigWriteHealth(ctx);

        const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(saved.agents.defaults?.systemAgent).toBeUndefined();
        expect(saved.agents.defaults?.heartbeat).toBeUndefined();
        expect(saved.models.providers.openai.models[0]).toEqual({
          id: "gpt-5.6-sol",
          name: "gpt-5.6-sol",
          api: "openai-chatgpt-responses",
          contextWindow: 272_000,
          contextTokens: 272_000,
        });

        const reread = await readConfigFileSnapshot();
        expect(reread.config.models?.providers?.openai?.models[0]).toMatchObject({
          reasoning: true,
          input: ["text", "image"],
          maxTokens: 128_000,
        });
        await using repeated = await prepareDoctorContext(configPath);
        expect(repeated.configResult.shouldWriteConfig).toBe(false);
      },
    );
  });
});
