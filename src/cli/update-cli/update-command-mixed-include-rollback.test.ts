import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  publishStagedIncludeWrites,
  restoreStagedIncludeWritesOrFold,
  type IncludeWriteRestorer,
} from "../../config/include-write-through.js";
import { hashConfigIncludeRaw } from "../../config/includes.js";
import { createConfigIO } from "../../config/io.factory.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { readUpdateStateSchemaVersionsInProcess } from "../../infra/update-candidate-state.js";
import { materializeUpdateCandidateStateWorker } from "../../infra/update-candidate-state.test-support.js";
import {
  captureUpdateDoctorConfigWrites,
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { createUpdateDoctorSectionTiming } from "../../infra/update-doctor-section-timing.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  captureUpdateConfigSnapshot,
  type UpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";
import { createPackageUpdateDoctorCompletion } from "./update-command-doctor-completion.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";

const roots = createSuiteTempRootTracker({ prefix: "mixed-doctor-rollback-" });
beforeAll(() => roots.setup());
afterEach(() => closeOpenClawStateDatabaseAsync());
afterAll(() => roots.cleanup());

it.each([false, true])(
  "restores mixed Doctor writes after a failed update while preserving later edits (edit=%s)",
  async (operatorEdit) => {
    const home = await roots.make("rollback");
    const stateDir = path.join(home, "state");
    await fs.mkdir(stateDir);
    const configPath = path.join(stateDir, "openclaw.json");
    const agentPath = path.join(stateDir, "agent.json5");
    const modelsPath = path.join(stateDir, "models.json5");
    const env = {
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_LOAD_SHELL_ENV: "0",
    };
    await withEnvAsync(env, async () => {
      const rootRaw = JSON.stringify({
        gateway: { mode: "local" },
        agents: { ownership: "explicit", entries: { work: { $include: "./agent.json5" } } },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: { $include: "./models.json5" },
            },
          },
        },
      });
      const agentRaw = '{"name":"Original agent"}\n';
      const modelsRaw = '[{"id":"llama3","name":"llama3"}]\n';
      await Promise.all([
        fs.writeFile(configPath, rootRaw),
        fs.writeFile(agentPath, agentRaw),
        fs.writeFile(modelsPath, modelsRaw),
      ]);
      const io = createConfigIO({ configPath, env, observe: false, pluginValidation: "core-only" });
      const snapshot = await io.readConfigFileSnapshot();
      const before = await captureUpdateConfigSnapshot(configPath, env);
      const schemaVersions = await readUpdateStateSchemaVersionsInProcess({
        stateDir,
        config: snapshot.sourceConfig,
        env,
      });
      const { packageRoot, transaction } = await createRetainedPackageSwap(
        path.join(home, "packages"),
        async ({ params }) => {
          await materializeUpdateCandidateStateWorker(params.stage.packageRoot);
        },
      );
      const resultPath = createUpdatePostInstallDoctorResultPath();
      try {
        await captureUpdateDoctorConfigWrites(configPath, async (capture) => {
          await io.writeConfigFile(
            {
              ...snapshot.sourceConfig,
              gateway: { ...snapshot.sourceConfig.gateway, port: 19111 },
              agents: { ownership: "explicit", entries: { work: { name: "Repaired agent" } } },
              models: {
                providers: {
                  ollama: {
                    api: "ollama",
                    baseUrl: "http://127.0.0.1:11434",
                    models: [
                      {
                        id: "qwen3",
                        name: "qwen3",
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        maxTokens: 8192,
                      },
                    ],
                  },
                },
              },
            },
            { baseSnapshot: snapshot, databaseAccess: "none", auditOrigin: "doctor" },
          );
          await writeUpdatePostInstallDoctorResult({
            resultPath,
            result: {
              status: "ok",
              configHash: capture.hash,
              configInputHash: capture.inputHash,
              configFileWrites: capture.fileWrites,
            },
          });
        });
        let activationConfig: UpdateConfigSnapshot | undefined;
        const completeDoctor = createPackageUpdateDoctorCompletion({
          root: packageRoot,
          progress: {},
          configSnapshot: before,
          onConfigSnapshot: (value) => {
            activationConfig = value;
          },
          sectionTiming: createUpdateDoctorSectionTiming(env),
          assertCurrent: () => {},
          doctorProgressInfo: { name: "doctor", command: "doctor", index: 1, total: 1 },
        });
        await completeDoctor(
          { name: "doctor", command: "doctor", cwd: packageRoot, durationMs: 0, exitCode: 0 },
          await consumeUpdatePostInstallDoctorResult(resultPath),
        );
        const operatorRaw = '{"name":"Operator edit"}\n';
        if (operatorEdit) {
          await fs.writeFile(agentPath, operatorRaw);
        }
        const outcome = await rollbackFailedUpdate({
          result: {
            status: "error",
            mode: "npm",
            root: packageRoot,
            before: { version: "1.0.0" },
            after: { version: "2.0.0" },
            reason: "activation-failed",
            steps: [],
            durationMs: 0,
          },
          previousRoot: packageRoot,
          packageTransaction: transaction,
          configSnapshot: snapshot,
          activationConfig,
          schemaVersions,
          opts: { json: true },
          timeoutMs: 10_000,
          nodeRunner: process.execPath,
          definitionRecovery: {},
        });
        expect(outcome.result.rollbackOutcome?.status).toBe(
          operatorEdit ? "not-attempted" : "succeeded",
        );
        expect(
          JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version,
        ).toBe(operatorEdit ? "2.0.0" : "1.0.0");
        expect(await fs.readFile(agentPath, "utf8")).toBe(operatorEdit ? operatorRaw : agentRaw);
        if (!operatorEdit) {
          expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
          expect(await fs.readFile(modelsPath, "utf8")).toBe(modelsRaw);
          expect(activationConfig?.includedFiles?.every((file) => file.doctorOwned)).toBe(true);
        }
      } finally {
        await fs.rm(resultPath, { force: true });
      }
    });
  },
);

it.each([false, true])(
  "records only successful include compensation in Doctor receipts (edit=%s)",
  async (operatorEdit) => {
    const home = await roots.make("compensation");
    const configPath = path.join(home, "openclaw.json");
    const targetPath = path.join(home, "agent.json5");
    const previousRaw = '{"name":"Original"}\n';
    const committedRaw = '{"name":"Repaired"}\n';
    const operatorRaw = '{"name":"Operator edit"}\n';
    await fs.writeFile(configPath, '{"agents":{"entries":{"work":{"$include":"./agent.json5"}}}}');
    await fs.writeFile(targetPath, previousRaw);
    await captureUpdateDoctorConfigWrites(configPath, async (capture) => {
      const restorers: IncludeWriteRestorer[] = [];
      await publishStagedIncludeWrites({
        configPath,
        restorers,
        staged: [
          {
            includePath: ["agents", "entries", "work"],
            targetPath,
            canonicalTargetPath: targetPath,
            includeGraphKey: targetPath,
            previousRaw,
            previousHash: hashConfigIncludeRaw(previousRaw),
            bytes: committedRaw,
          },
        ],
      });
      if (operatorEdit) {
        await fs.writeFile(targetPath, operatorRaw);
      }
      const failure = new Error("Root publication failed");
      expect(await restoreStagedIncludeWritesOrFold(restorers, failure, { configPath })).toBe(
        failure,
      );
      expect(await fs.readFile(targetPath, "utf8")).toBe(operatorEdit ? operatorRaw : previousRaw);
      expect(capture.fileWrites?.[targetPath]).toEqual({
        inputHash: hashConfigRaw(previousRaw),
        hash: hashConfigRaw(operatorEdit ? committedRaw : previousRaw),
      });
    });
  },
);
