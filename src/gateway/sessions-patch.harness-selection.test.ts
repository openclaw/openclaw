import { expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  MAIN_SESSION_KEY,
  expectPatchError,
  expectPatchOk,
  runPatch,
} from "./sessions-patch.test-support.js";

const cfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
  plugins: { entries: { codex: { enabled: false } } },
} as OpenClawConfig;
const patch = { key: MAIN_SESSION_KEY, model: "openai/gpt-5.6-luna" };
const loadGatewayModelCatalog = async () =>
  ["gpt-5.6-sol", "gpt-5.6-luna"].map((id) => ({ provider: "openai", id, name: id }));

test("accepts an OpenAI model whose implicit Codex harness has no enabled owner", async () => {
  // A turn runs this selection on OpenClaw, so selecting it must not fail.
  const entry = expectPatchOk(await runPatch({ cfg, patch, loadGatewayModelCatalog }));
  expect(entry.providerOverride).toBe("openai");
  expect(entry.modelOverride).toBe("gpt-5.6-luna");
});

test("rejects an explicit Codex pin that has no enabled owner", async () => {
  const pinned = {
    ...cfg,
    agents: {
      defaults: {
        ...cfg.agents?.defaults,
        models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } },
      },
    },
  } as OpenClawConfig;
  expectPatchError(
    await runPatch({ cfg: pinned, patch, loadGatewayModelCatalog }),
    'requires agent harness "codex"',
  );
});
