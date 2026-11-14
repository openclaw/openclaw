import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveApiKeyForProviderCore } from "../../agents/model-auth.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as image from "../../image-generation/runtime.js";
import * as media from "../../media-understanding/runtime.js";
import * as memory from "../../plugin-sdk/memory-core-bundled-runtime.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "../../secrets/runtime.test-support.ts";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as video from "../../video-generation/runtime.js";
import { registerCapabilityCli } from "../capability-cli.js";

setupSecretsRuntimeSnapshotTestHooks();

type ProviderEgressParams = { cfg?: OpenClawConfig; config?: OpenClawConfig; agentDir?: string };

const auth: Array<{ source?: string; apiKey?: string }> = [];
const provider = "customacct";

// Resolve real saved-account auth at each mocked provider's egress boundary.
function withEgressAuth<T>(result: T) {
  return vi.fn(async (params: ProviderEgressParams) => {
    const { source, apiKey } = await resolveApiKeyForProviderCore({
      provider,
      cfg: params.cfg ?? params.config,
      agentDir: params.agentDir,
    });
    auth.push({ source, apiKey });
    return result;
  });
}

beforeEach(() => {
  const generated = { provider, model: "test-model", attempts: [], ignoredOverrides: [] };
  vi.spyOn(image, "generateImage").mockImplementation(withEgressAuth({ ...generated, images: [] }));
  vi.spyOn(video, "generateVideo").mockImplementation(withEgressAuth({ ...generated, videos: [] }));
  for (const method of ["describeImageFile", "describeVideoFile", "transcribeAudioFile"] as const) {
    vi.spyOn(media, method).mockImplementation(withEgressAuth({ text: "synthetic-ok" }));
  }
  vi.spyOn(memory, "createEmbeddingProvider").mockImplementation(
    withEgressAuth<Awaited<ReturnType<typeof memory.createEmbeddingProvider>>>({
      requestedProvider: "customacct",
      provider: {
        id: "customacct",
        model: "test-model",
        embed: async () => [0.5],
        embedBatch: async (inputs) => inputs.map(() => [0.5]),
      },
    }),
  );
});
afterEach(() => vi.restoreAllMocks());

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: vi.fn(async (_runtime: unknown, run: () => Promise<void>) => await run()),
}));

vi.mock("./output.js", () => ({
  emitJsonOrText: vi.fn(),
  formatEnvelopeForText: vi.fn(),
  providerSummaryText: vi.fn(),
}));

const envKey = "OPENCLAW_TEST_CAPABILITY_ACCOUNT_KEY";
const apiKey = "synthetic-capability-account-key"; // pragma: allowlist secret

async function runLocalCapability(argv: string[], agent = "ops"): Promise<void> {
  const capability = new Command();
  const args = ["infer", ...argv, "--agent", agent, "--json"];
  await registerCapabilityCli(capability, ["node", "openclaw", ...args]);
  await capability.parseAsync(args, { from: "user" });
}

it.each([
  ["image", "generate", "--prompt", "a red square"],
  ["image", "describe", "--file", "input.png"],
  ["embedding", "create", "--text", "hello", "--provider", "customacct"],
  ["audio", "transcribe", "--file", "input.wav"],
  ["video", "generate", "--prompt", "a red square"],
  ["video", "describe", "--file", "input.mp4"],
])("infer %s %s uses only the durable owner’s saved credential", async (...argv) =>
  withOpenClawTestState({ env: { [envKey]: apiKey } }, async (state) => {
    const agentDir = state.agentDir("ops");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { ops: { agentDir } } },
    };
    setRuntimeConfigSnapshot(structuredClone(cfg), structuredClone(cfg));
    auth.length = 0;
    await state.writeAuthProfiles(
      {
        version: 1,
        profiles: {
          "customacct:saved": {
            type: "api_key",
            provider: "customacct",
            keyRef: { source: "env", provider: "default", id: envKey },
          },
        },
      },
      "ops",
    );
    await runLocalCapability(argv);
    expect(auth).toEqual([{ source: "profile:customacct:saved", apiKey }]);
    cfg.agents = { ...cfg.agents, entries: { restored: { agentDir } } };
    for (const activeSnapshot of [true, false]) {
      if (!activeSnapshot) {
        clearSecretsRuntimeSnapshotState();
      }
      setRuntimeConfigSnapshot(structuredClone(cfg), structuredClone(cfg));
      await expect(runLocalCapability(argv, "restored")).rejects.toThrow(
        "belongs to agent ops; requested agent restored",
      );
      expect(auth).toHaveLength(1);
    }
  }),
);
