import { assert, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { configFor } from "../agents/model-auth.fixtures.test-support.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

// mock-isolation: Model-policy fixtures intentionally have no ACP metadata and must not open real session stores.
vi.mock("../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntryAsync: async () => undefined,
}));

const key = "agent:main:model-policy";
const denied = {
  code: "FORBIDDEN",
  message: expect.stringContaining("operator role cannot use this model"),
};

function fixture(defaultOnly = false) {
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: {
      defaults: {
        model: { primary: "fixture/blocked", fallbacks: ["fixture/allowed"] },
        modelPolicy: { allow: defaultOnly ? ["fixture/blocked"] : ["fixture/*"] },
        models: { "fixture/blocked": { alias: "blocked" }, "fixture/allowed": { alias: "chosen" } },
      },
    },
    ...configFor("fixture", "https://fixture.invalid/v1", {
      api: "openai-completions",
      agentRuntime: { id: "openclaw" },
    }),
  };
  const entries = [
    { provider: "fixture", id: "blocked", name: "Blocked" },
    {
      provider: "fixture",
      id: "allowed",
      name: "Allowed",
      contextWindows: [{ id: "extended", label: "Extended", contextWindow: 200_000 }],
    },
  ];
  const initial: SessionEntry = {
    sessionId: "fixture-session",
    updatedAt: 1,
    providerOverride: "fixture",
    modelOverride: "blocked",
    contextWindow: "extended",
  };
  const source = new AbortController();
  let modelPolicy = prepareOperatorModelPolicy({ cfg, policy: { deny: ["fixture/blocked"] } });
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "limited-operator",
    scopes: ["operator.write"],
    assertCurrent: () => source.signal.throwIfAborted(),
    get modelPolicy() {
      return modelPolicy;
    },
  });
  const revoke = () => source.abort(new Error("operator source changed"));
  const tighten = () => {
    modelPolicy = prepareOperatorModelPolicy({ cfg, policy: { allow: [] } });
  };
  const project = async (model: string | null, duringPreparation?: () => void) => {
    const before = structuredClone(initial);
    const result = await projectSessionsPatchEntry({
      cfg,
      operatorAuthority,
      existingEntry: initial,
      isLabelInUse: () => false,
      storeKey: key,
      patch: { key, model },
      loadGatewayModelCatalogSnapshot: async () => {
        duringPreparation?.();
        return { entries, routeVariants: entries };
      },
    });
    expect(initial).toEqual(before);
    return result;
  };
  return { initial, project, revoke, tighten };
}

describe("session model patches under operator policy", () => {
  it.each<[string | null, "source" | "model-policy" | undefined]>([
    ["fixture/blocked", undefined],
    ["blocked", undefined],
    [null, undefined],
    ["fixture/allowed", "source"],
    ["fixture/allowed", "model-policy"],
  ])("validates model %s after preparation (change=%s)", async (model, change) => {
    const value = fixture(model === null);
    const result = await value.project(
      model,
      change === "source" ? value.revoke : change === "model-policy" ? value.tighten : undefined,
    );

    if (model === null) {
      assert(result.ok);
      const { contextWindow, providerOverride, modelOverride } = result.entry;
      expect([contextWindow, providerOverride, modelOverride]).toEqual([
        "extended",
        undefined,
        undefined,
      ]);
    } else {
      expect(result).toMatchObject({
        ok: false,
        error:
          change === "source"
            ? { ...denied, message: expect.stringContaining("operator source changed") }
            : denied,
      });
    }
  });

  it("retains the exact selected-model guard until the write commits", async () => {
    const value = fixture();
    const result = await value.project("chosen");
    expect(result).toMatchObject({
      ok: true,
      entry: { providerOverride: "fixture", modelOverride: "allowed", contextWindow: "extended" },
    });
    assert(result.ok);
    expect(result.validateModelSelection?.()).toBeUndefined();
    value.tighten();
    expect(result.validateModelSelection?.()).toMatchObject(denied);
  });
});
