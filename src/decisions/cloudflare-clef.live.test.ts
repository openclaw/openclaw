import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createDecisionTool } from "../agents/tools/decision-tool.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "../plugins/loader.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { prepareDecisionProviderReload } from "./runtime.js";
import type { DecisionBatchV2, DecisionOutcomeV2 } from "./types-v2.js";

const enabled =
  process.platform !== "win32" &&
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.OPENCLAW_LIVE_CF_CLEF === "1";
const describeLive = enabled ? describe : describe.skip;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
// Synthetic red square; no user media.
const redImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAADGklEQVR4nO3OQQ0AMBAEofVvupUxjyNBAHsbnNUPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPIPQBWUwO8hhpVuIAAAAASUVORK5CYII=";

// No inference, auth, authority, or transport mocks. A loaded consumer calls the
// public SDK; the loaded provider gets its context from prepared host dispatch.
describeLive("Cloudflare Clef registered authority and process settlement", () => {
  it("dispatches with CLI OAuth, fences disposed consumers/providers, and settles cancellation", async () => {
    const workspaceDir = tempDirs.make("openclaw-clef-host-live-");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(workspaceDir, "openclaw.json"));
    vi.stubEnv("OPENCLAW_AGENT_DIR", path.join(workspaceDir, "agent"));
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(workspaceDir, "agent"));
    const consumerDir = path.join(workspaceDir, "consumer");
    await mkdir(consumerDir);
    await writeFile(
      path.join(consumerDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "clef-proof-consumer",
        contracts: { tools: ["clef_proof"] },
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    await writeFile(
      path.join(consumerDir, "index.ts"),
      `
export default { id: "clef-proof-consumer", register(api) {
  api.registerTool({ name: "clef_proof", label: "Clef proof", description: "Synthetic live proof",
    parameters: { type: "object" }, async execute(_id, batch, signal) {
      const outcome = await api.runtime.decisions.evaluateV2(batch, {
        agentId: "main", purpose: "clef.host-proof", rubricVersion: "1",
        timeoutMs: 30000, signal: signal ?? new AbortController().signal,
      });
      return { content: [{ type: "text", text: JSON.stringify(outcome) }], details: outcome };
    }
  });
}};
`,
    );
    const receiptsFile = path.join(workspaceDir, "dispatch.jsonl");
    await writeFile(receiptsFile, "");
    const binaryPath = path.join(workspaceDir, "cf-observed");
    // Observe the final OS effect without replacing cf or its OAuth. Private
    // paths/PIDs are asserted locally, never included in the published log.
    await writeFile(
      binaryPath,
      `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
// No detached flag or signal forwarder: cf inherits the observer's POSIX group.
// This deliberately proves the transport kills the whole group, not just its direct child.
const child = spawn(${JSON.stringify(process.env.OPENCLAW_LIVE_CF_BINARY ?? "cf")}, args, { stdio: "inherit" });
child.on("spawn", () => fs.appendFileSync(${JSON.stringify(receiptsFile)}, JSON.stringify({
  pid: process.pid, childPid: child.pid, body: args[args.indexOf("--body") + 1].slice(1)
}) + "\\n"));
child.on("error", () => process.exit(1));
child.on("close", code => process.exit(code ?? 1));
`,
      { mode: 0o700 },
    );
    const config: OpenClawConfig = {
      agents: {
        defaults: { workspace: workspaceDir, decisionModel: "cloudflare-clef/clef-flash" },
        entries: { main: {} },
      },
      plugins: {
        allow: ["cloudflare-clef", "clef-proof-consumer"],
        load: { paths: [consumerDir] },
        slots: { memory: "none" },
        entries: {
          "cloudflare-clef": {
            enabled: true,
            config: {
              binaryPath,
              ...(process.env.OPENCLAW_LIVE_CF_PROFILE
                ? { profile: process.env.OPENCLAW_LIVE_CF_PROFILE }
                : {}),
            },
          },
          "clef-proof-consumer": { enabled: true },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const registry = loadOpenClawPlugins({
      config,
      workspaceDir,
      onlyPluginIds: ["cloudflare-clef", "clef-proof-consumer"],
      pluginSdkResolution: "src",
      preferBuiltPluginArtifacts: false,
      cache: false,
      env: {
        ...process.env,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      },
    });
    const receipts = async (): Promise<Array<{ pid: number; childPid: number; body: string }>> =>
      (await readFile(receiptsFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    try {
      expect(
        registry.decisionProviders.some((entry) => entry.host.provider.id === "cloudflare-clef"),
      ).toBe(true);
      const registration = registry.tools.find((entry) => entry.names.includes("clef_proof"));
      expect(registration).toBeDefined();
      const tool = registration!.factory({ config, workspaceDir, agentId: "main" });
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected one registered proof tool");
      }
      const batch: DecisionBatchV2 = {
        state: { type: "image", dataUri: redImage, text: "Evaluate the supplied square." },
        questions: { red: { type: "boolean", instructions: "Is the square red?" } },
      };
      const source = new AbortController();
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "synthetic-clef-proof",
        scopes: ["operator.write"],
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
      });
      const caller = {
        agentId: "main",
        sessionKey: "agent:main:clef-proof",
        operatorAuthority,
      };
      const asCaller = (id: string) =>
        withGatewayToolCallerIdentity(caller, () => tool.execute(id, batch));
      const allowed = await asCaller("allowed");
      const outcome = allowed.details as DecisionOutcomeV2;
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        status: "ok",
        result: { model: "clef-flash", answers: { red: { type: "boolean" } } },
        provenance: { providerId: "cloudflare-clef" },
      });
      if (outcome.status !== "ok" || outcome.result.answers.red?.type !== "boolean") {
        throw new Error("Expected Boolean result");
      }
      expect(outcome.result.answers.red.probabilityTrue).toBeGreaterThan(0.5);
      expect(await receipts()).toHaveLength(1);
      console.log(
        JSON.stringify({
          case: "allowed-sdk-dispatch",
          outcome: allowed.details,
          cliDispatches: 1,
        }),
      );

      // Picker discovery and SDK dispatch do not prove the core tool bridge.
      const nativeTool = createDecisionTool("main", { config });
      if (!nativeTool) {
        throw new Error("Expected the configured native Decision tool");
      }
      const asNativeCaller = (id: string) =>
        withGatewayToolCallerIdentity(caller, () =>
          nativeTool.execute(id, { contractVersion: 2, ...batch }),
        );
      const native = await asNativeCaller("allowed-native");
      const nativeOutcome = native.details as DecisionOutcomeV2;
      expect(nativeOutcome, JSON.stringify(nativeOutcome)).toMatchObject({
        status: "ok",
        result: { model: "clef-flash", answers: { red: { type: "boolean" } } },
        provenance: { providerId: "cloudflare-clef" },
      });
      if (nativeOutcome.status !== "ok" || nativeOutcome.result.answers.red?.type !== "boolean") {
        throw new Error("Expected native Boolean result");
      }
      expect(nativeOutcome.result.answers.red.probabilityTrue).toBeGreaterThan(0.5);
      expect(await receipts()).toHaveLength(2);
      console.log(
        JSON.stringify({
          case: "allowed-native-dispatch",
          outcome: native.details,
          cliDispatches: 1,
        }),
      );

      source.abort(new Error("synthetic operator source revoked"));
      await expect(async () => asCaller("revoked-caller")).rejects.toThrow(
        "synthetic operator source revoked",
      );
      await expect(async () => asNativeCaller("revoked-native-caller")).rejects.toThrow(
        "synthetic operator source revoked",
      );
      expect(await receipts()).toHaveLength(2);
      console.log(
        JSON.stringify({
          case: "revoked-caller-source",
          rejected: true,
          additionalCliDispatches: 0,
        }),
      );

      const controller = new AbortController();
      const pending = tool.execute("cancel", batch, controller.signal);
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(async () => expect(await receipts()).toHaveLength(3), { timeout: 15000 });
        controller.abort(new Error("synthetic caller cancellation"));
        expect(await settled).toMatchObject({
          error: { message: "synthetic caller cancellation" },
        });
      } finally {
        controller.abort();
        await settled;
      }
      const dispatched = await receipts();
      for (const receipt of dispatched) {
        await expect(access(receipt.body)).rejects.toMatchObject({ code: "ENOENT" });
        expect(() => process.kill(receipt.pid, 0)).toThrow();
        await vi.waitFor(() => expect(() => process.kill(receipt.childPid, 0)).toThrow());
      }
      expect(registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
      console.log(
        JSON.stringify({
          case: "caller-cancellation",
          rejected: true,
          activeRequests: 0,
          childProcessesAlive: 0,
          requestFilesRemaining: 0,
        }),
      );

      const consumer = registry.plugins.find((entry) => entry.id === "clef-proof-consumer")!;
      await getPluginInstance(consumer)!.dispose();
      await expect(async () => tool.execute("revoked-consumer", batch)).rejects.toThrow(
        /reloaded or disabled/,
      );
      expect(await receipts()).toHaveLength(3);
      console.log(
        JSON.stringify({ case: "disposed-consumer", rejected: true, additionalCliDispatches: 0 }),
      );

      prepareDecisionProviderReload(registry, new Set(["cloudflare-clef"]));
      const { evaluateDecisionV2InRegistry } = await import("./runtime.js");
      const revoked = await evaluateDecisionV2InRegistry(
        batch,
        {
          purpose: "clef.revoked-provider",
          rubricVersion: "1",
          timeoutMs: 30000,
          signal: new AbortController().signal,
        },
        registry,
        config,
      );
      expect(revoked).toEqual({ status: "unavailable", reason: "retiring" });
      expect(await receipts()).toHaveLength(3);
      console.log(
        JSON.stringify({ case: "revoked-provider", outcome: revoked, additionalCliDispatches: 0 }),
      );
    } finally {
      prepareDecisionProviderReload(registry, new Set(registry.plugins.map((entry) => entry.id)));
      for (const record of registry.plugins) {
        await getPluginInstance(record)?.dispose();
      }
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();
      clearPluginRegistryLoadCache();
    }
  }, 90000);
});
