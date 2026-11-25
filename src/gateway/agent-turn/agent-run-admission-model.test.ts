import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as storeLookup from "../session-utils-store-lookup.js";
import { resolveAgentRunAdmissionModel } from "./agent-run-admission-model.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

const parentKey = "agent:main:dashboard:inherit-parent";
const childKey = "agent:main:dashboard:inherit-child";

async function admit(request: { provider?: string; model?: string } = {}) {
  state = await createOpenClawTestState({ label: "agent-admission-model" });
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: { model: "clawrouter/anthropic/claude-opus-5-5" } },
      defaults: { workspace: state.workspaceDir },
    },
    plugins: { enabled: false },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  await replaceSessionEntry(
    { agentId: "main", sessionKey: parentKey, env: state.env },
    {
      sessionId: "inherit-parent",
      updatedAt: 1,
      providerOverride: "anthropic",
      modelOverride: "claude-opus-5-5",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    },
  );
  // No selection of its own: the session's turns run on the parent's pick.
  const sessionEntry: SessionEntry = {
    sessionId: "inherit-child",
    updatedAt: 1,
    parentSessionKey: parentKey,
  };
  await replaceSessionEntry(
    { agentId: "main", sessionKey: childKey, env: state.env },
    sessionEntry,
  );
  const emitAcceptance = vi.fn();
  const admission = await resolveAgentRunAdmissionModel({
    cfg,
    request: {},
    sessionEntry,
    resolvedSessionKey: childKey,
    activeSessionAgentId: "main",
    providerOverride: request.provider,
    modelOverride: request.model,
    allowModelOverride: Boolean(request.model),
    lifecycleStorePath: "",
    io: { emitAcceptance },
  });
  expect(emitAcceptance).not.toHaveBeenCalled();
  return admission;
}

it("admits an agent run on the model the session inherits from its parent", async () => {
  const admission = await admit();

  expect(admission?.resolvedRuntime).toMatchObject({
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
  expect(admission?.providerFacts.providerId).toBe("anthropic");
});

it("admits a request naming provider and model without reading the parent session", async () => {
  vi.spyOn(storeLookup, "resolveGatewaySessionStoreTargetWithStoreAsync").mockRejectedValue(
    new Error("parent session database unavailable"),
  );
  const admission = await admit({ provider: "clawrouter", model: "openai/gpt-6-astra" });

  expect(admission?.resolvedRuntime).toMatchObject({
    provider: "clawrouter",
    model: "openai/gpt-6-astra",
  });
});
