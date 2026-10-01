import { describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

vi.mock("../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntry: () => undefined,
}));

const key = "agent:main:model-policy";

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
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          agentRuntime: { id: "openclaw" },
          models: [],
        },
      },
    },
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
  let current = true;
  let modelPolicy = prepareOperatorModelPolicy({ cfg, policy: { deny: ["fixture/blocked"] } });
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "limited-operator",
    scopes: ["operator.write"],
    assertCurrent: () => {
      if (!current) {
        throw new Error("operator source changed");
      }
    },
    get modelPolicy() {
      return modelPolicy;
    },
  });
  const revoke = () => {
    current = false;
  };
  const tighten = () => {
    modelPolicy = prepareOperatorModelPolicy({ cfg, policy: { allow: [] } });
  };
  const project = (model: string | null, duringPreparation?: () => void) =>
    projectSessionsPatchEntry({
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
  return { initial, project, revoke, tighten };
}

describe("session model patches under operator policy", () => {
  it.each([
    { model: "fixture/blocked", allowed: false },
    { model: "blocked", allowed: false },
    { model: "chosen", allowed: true },
    { model: null, allowed: true },
    { model: "fixture/allowed", allowed: false, change: "source" },
    { model: "fixture/allowed", allowed: false, change: "model-policy" },
  ])(
    "validates model $model after preparation (change=$change)",
    async ({ model, allowed, change }) => {
      const value = fixture(model === null);
      const before = structuredClone(value.initial);
      const result = await value.project(
        model,
        change === "source" ? value.revoke : change === "model-policy" ? value.tighten : undefined,
      );

      if (allowed) {
        expect(result).toMatchObject({ ok: true, entry: { contextWindow: "extended" } });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        expect(result.entry.providerOverride).toBe(model === null ? undefined : "fixture");
        expect(result.entry.modelOverride).toBe(model === null ? undefined : "allowed");
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: expect.stringContaining(
              change === "source"
                ? "operator source changed"
                : "operator role cannot use this model",
            ),
          },
        });
      }
      expect(value.initial).toEqual(before);
    },
  );

  it("retains the exact selected-model guard until the write commits", async () => {
    const value = fixture();
    const result = await value.project("chosen");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.validateModelSelection?.()).toBeUndefined();
    value.tighten();
    expect(result.validateModelSelection?.()).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("operator role cannot use this model"),
    });
    expect(value.initial.modelOverride).toBe("blocked");
  });
});
