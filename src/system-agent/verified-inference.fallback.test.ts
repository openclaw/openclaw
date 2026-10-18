import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { captureRuntimeConfigAsyncReader, readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { isSystemAgentInferenceUnavailableError } from "./inference-error.js";
import { resolvePersistentApplyInference, verifySetupInference } from "./setup-inference-turn.js";

afterEach(() => cliBackendsTesting.resetDepsForTest());
const runtime: RuntimeEnv = {
  log() {},
  error() {},
  exit() {
    throw new Error("unexpected exit");
  },
};

it.each(["unchanged", "revoked"] as const)(
  "reprobes the opaque fallback and checks %s authority before secret persistence",
  async (authority) => {
    await withOpenClawTestState({ label: "opaque-configured-fallback" }, async (state) => {
      const callsPath = state.path("cli-calls.jsonl");
      const interpreter = await fs.realpath(process.execPath);
      await state.writeJson("fixture-cli/package.json", {
        name: "@fixture/verified-fallback-cli",
        version: "1.0.0",
        type: "module",
      });
      const script = await state.writeText(
        "fixture-cli/cli.mjs",
        `#!${interpreter}
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + "\\n");
process.stdout.write("OK\\n");
`,
      );
      await fs.chmod(script, 0o755);
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            id: "fixture-cli",
            pluginId: "fixture",
            nativeToolMode: "none",
            sideQuestionToolMode: "disabled",
            runtimeArtifact: {
              kind: "bundled-package-tree",
              packageName: "@fixture/verified-fallback-cli",
              entrypoint: "command",
            },
            config: {
              command: script,
              args: [callsPath],
              modelArg: "--model",
              output: "text",
              input: "arg",
              sessionMode: "none",
              systemPromptWhen: "never",
            },
          },
        ],
      });
      const fallbackModelRef = "fixture-cli/second";
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          entries: {
            ops: {
              model: { primary: "fixture-primary/first", fallbacks: [fallbackModelRef] },
            },
          },
        },
      };
      await state.writeConfig(config);
      const readSnapshot = () =>
        readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
      await captureRuntimeConfigAsyncReader()();
      const result = await verifySetupInference({
        agentId: "ops",
        fallbackModelRef,
        bindSession: true,
        runtime,
        deps: { readConfigFileSnapshot: readSnapshot },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.binding.auth).toMatchObject({
        proofKind: "runtime-owner",
        runtimeOwnerKind: "cli-runtime",
        runtimeOwnerId: "fixture-cli",
      });
      expect(result.binding.execution.fallbackModelRef).toBe(fallbackModelRef);
      const readCalls = async (): Promise<unknown[]> =>
        (await fs.readFile(callsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      expect(await readCalls()).toEqual([expect.arrayContaining(["--model", "second"])]);
      await captureRuntimeConfigAsyncReader()();
      await expect(
        resolvePersistentApplyInference({
          binding: result.binding,
          runtime,
          deps: { readConfigFileSnapshot: readSnapshot },
        }),
      ).resolves.toBe(result.binding.execution);
      expect(await readCalls()).toEqual([
        expect.arrayContaining(["--model", "second"]),
        expect.arrayContaining(["--model", "second"]),
      ]);
      const { SystemAgentChatEngine } = await import("./chat-engine.js");
      const { listSecretStoreEntries, readSecretStoreValue } =
        await import("../secrets/store/secret-store.js");
      const engine = new SystemAgentChatEngine({
        verifiedInference: result.binding,
        runAgentTurn: async () => null,
        deps: { readConfigFileSnapshot: readSnapshot },
      });
      try {
        engine.propose({
          kind: "config-set-ref",
          path: "memory.search.remote.apiKey",
          source: "store",
          id: "OPAQUE_FALLBACK_PROOF",
          secret: "synthetic-opaque-fallback-not-a-credential",
        });
        const proposal = engine.getPendingOperatorProposal();
        if (!proposal) {
          throw new Error("Missing owner-approved fixture operation");
        }
        let revoked = false;
        const apply = engine.resolveOperatorApproval("allow-once", proposal.hash, () => {
          if (authority !== "revoked" || revoked) {
            return;
          }
          revoked = true;
          config.agents!.entries!.ops!.model = {
            primary: "fixture-primary/first",
            fallbacks: [],
          };
          writeFileSync(state.configPath, JSON.stringify(config));
        });
        if (authority === "revoked") {
          await expect(apply).rejects.toSatisfy(isSystemAgentInferenceUnavailableError);
        } else {
          expect((await apply)?.applied).toBe(true);
        }
        const entries = await listSecretStoreEntries({ scope: { kind: "team" } });
        const saved = await readSnapshot();
        const reference = saved.sourceConfig.memory?.search?.remote?.apiKey;
        if (authority === "revoked") {
          expect(entries).toEqual([]);
          expect(reference).toBeUndefined();
        } else {
          expect(entries).toHaveLength(1);
          const entry = entries[0]!;
          expect(reference).toMatchObject({ source: "store", id: entry.name });
          expect(
            await readSecretStoreValue({ scope: { kind: "team" }, name: entry.name }),
          ).toMatchObject({ ok: true, value: "synthetic-opaque-fallback-not-a-credential" });
        }
        process.stdout.write(
          "[opaque-fallback-persistence-proof] " +
            JSON.stringify({
              authority,
              nativeCliProbes: (await readCalls()).length,
              secretEntries: entries.length,
              configReferenceWritten: reference !== undefined,
            }) +
            "\n",
        );
      } finally {
        await engine.dispose();
      }
    });
  },
);
