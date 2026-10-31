import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { captureRuntimeConfigAsyncReader, readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { isSystemAgentInferenceUnavailableError } from "./inference-error.js";
import { resolvePersistentApplyInference, verifySetupInference } from "./setup-inference-turn.js";

afterEach(async () => {
  cliBackendsTesting.resetDepsForTest();
  const { clearSecretsRuntimeSnapshot } = await import("../secrets/runtime.js");
  clearSecretsRuntimeSnapshot();
});
const runtime: RuntimeEnv = {
  log() {},
  error() {},
  exit() {
    throw new Error("unexpected exit");
  },
};

it.each([
  { authority: "unchanged", storedProfile: false },
  { authority: "revoked", storedProfile: false },
  { authority: "unchanged", storedProfile: true },
  { authority: "revoked", storedProfile: true },
  { authority: "unrelated", storedProfile: false },
] as const)(
  "checks $authority authority before secret persistence (stored CLI profile: $storedProfile)",
  async ({ authority, storedProfile }) => {
    await withOpenClawTestState({ label: "opaque-configured-fallback" }, async (state) => {
      const callsPath = state.path("cli-calls.jsonl");
      const backendId = storedProfile ? "claude-cli" : "fixture-cli";
      const profileId = "claude-cli:fixture";
      const credentialName = "CLI_STORED_CREDENTIAL";
      const { writeSecretStoreEntry } = await import("../secrets/store/secret-store.js");
      if (storedProfile) {
        await writeSecretStoreEntry({
          scope: { kind: "team" },
          name: credentialName,
          value: "synthetic-stored-cli-not-a-credential",
          kind: "secret",
          updatedBy: "cli",
        });
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "api_key",
                provider: "claude-cli",
                keyRef: { source: "store", provider: "default", id: credentialName },
              },
            },
          },
          "ops",
        );
      }
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
            id: backendId,
            ...(storedProfile
              ? { modelProvider: "anthropic", authEpochMode: "profile-only" as const }
              : {}),
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
      const fallbackModelRef = `${backendId}/second${storedProfile ? `@${profileId}` : ""}`;
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
      if (storedProfile) {
        const { activateSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } =
          await import("../secrets/runtime.js");
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config,
          env: state.env,
          agentDirs: [state.agentDir("ops")],
          includeAuthStoreRefs: true,
          loadablePluginOrigins: new Map(),
        });
        expect(snapshot.degradedOwners).toEqual([]);
        activateSecretsRuntimeSnapshot(snapshot);
      }
      const readSnapshot = () =>
        readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
      await captureRuntimeConfigAsyncReader()();
      const result = await verifySetupInference({
        agentId: "ops",
        fallbackModelRef,
        bindSession: true,
        runtime,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (storedProfile) {
        expect(result.binding.auth.authProfileId).toBe(profileId);
        expect(result.binding.auth.proofKind).toBeUndefined();
      } else {
        expect(result.binding.auth).toMatchObject({
          proofKind: "runtime-owner",
          runtimeOwnerKind: "cli-runtime",
          runtimeOwnerId: "fixture-cli",
        });
      }
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
        }),
      ).resolves.toBe(result.binding.execution);
      // Materialized profiles revalidate their credential fingerprint; only
      // opaque runtime ownership needs a second live inference probe.
      expect(await readCalls()).toEqual(
        storedProfile
          ? [expect.arrayContaining(["--model", "second"])]
          : [
              expect.arrayContaining(["--model", "second"]),
              expect.arrayContaining(["--model", "second"]),
            ],
      );
      const { SystemAgentChatEngine } = await import("./chat-engine.js");
      const { listSecretStoreEntries, readSecretStoreValue } =
        await import("../secrets/store/secret-store.js");
      const engine = new SystemAgentChatEngine({
        verifiedInference: result.binding,
        runAgentTurn: async () => null,
      });
      const secretStore = await import("../secrets/store/secret-store.js");
      const writeSecret = secretStore.writeSecretStoreEntryForConfigRef;
      const writeSpy =
        authority === "unrelated"
          ? vi
              .spyOn(secretStore, "writeSecretStoreEntryForConfigRef")
              .mockImplementation((params) => {
                config.gateway = { ...config.gateway, port: 19876 };
                writeFileSync(state.configPath, JSON.stringify(config));
                return writeSecret(params);
              })
          : undefined;
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
        const allEntries = await listSecretStoreEntries({ scope: { kind: "team" } });
        if (storedProfile) {
          expect(
            await readSecretStoreValue({ scope: { kind: "team" }, name: credentialName }),
          ).toEqual({
            ok: true,
            value: "synthetic-stored-cli-not-a-credential",
          });
          expect(allEntries.filter((entry) => entry.name === credentialName)).toHaveLength(1);
        }
        const entries = allEntries.filter((entry) => entry.name !== credentialName);
        const saved = await readSnapshot();
        const reference = saved.sourceConfig.memory?.search?.remote?.apiKey;
        if (authority === "unrelated") {
          expect(saved.config.gateway?.port).toBe(19876);
          expect(await readCalls()).toHaveLength(6);
        }
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
              storedProfile,
              nativeCliProbes: (await readCalls()).length,
              secretEntries: entries.length,
              configReferenceWritten: reference !== undefined,
            }) +
            "\n",
        );
      } finally {
        writeSpy?.mockRestore();
        await engine.dispose();
      }
    });
  },
);
