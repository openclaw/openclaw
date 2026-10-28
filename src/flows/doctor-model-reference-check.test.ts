import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as gateway from "../gateway/call.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import { modelReferenceCheck } from "./doctor-model-reference-check.js";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(gateway, "isImplicitLocalGatewayTarget").mockResolvedValue(true);
  vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
    pid: 123,
    port: 19568,
    createdAt: "fixture",
  });
});
const detect = (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) =>
  modelReferenceCheck.detect({
    mode: "lint",
    env,
    cfg,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });

it.each(["published", "other-provider", "offline"])(
  "checks runtime-only models against the selected Gateway (%s)",
  async (catalogState) => {
    const call = vi.spyOn(gateway, "callGateway");
    if (catalogState === "offline") {
      call.mockRejectedValue(new Error("Gateway offline"));
    } else {
      call.mockResolvedValue({
        models: [
          {
            provider: catalogState === "published" ? "google" : "ollama",
            id: "gemini-flash-lite-latest",
            name: "Runtime model",
          },
        ],
      });
    }
    const ref = "google/gemini-flash-lite-latest";
    const typo = "google/gemini-flash-lite-lates";
    const findings = await detect(
      { agents: { defaults: { imageModel: { primary: ref, fallbacks: [typo] } } } },
      {},
    );
    expect(findings.map((finding) => finding.target)).toEqual(
      catalogState === "published" ? [typo] : [ref, typo],
    );
  },
);

it("uses only prepared Gateway warnings in Doctor", async () => {
  const call = vi.spyOn(gateway, "callGateway").mockResolvedValue({
    models: [],
    providerOutcomes: [
      { provider: "ollama", status: "ready", unlistedConfiguredModelIds: ["qwen3:8bb"] },
    ],
  });
  const findings = await detect({});
  expect(findings.filter((finding) => finding.target === "ollama/qwen3:8bb")).toEqual([
    expect.objectContaining({
      severity: "warning",
      fixHint: expect.stringContaining("Pull or download it on that server"),
    }),
  ]);
  expect(call).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: "models.list",
      sharedStateMode: "read-only",
      params: { view: "all", includeDetails: true, preparedOnly: true },
    }),
  );
});

it("does not execute Gateway secret providers without Doctor's allow-exec opt-in", async () => {
  const call = vi.spyOn(gateway, "callGateway").mockResolvedValue({ models: [] });
  const findings = await detect(
    {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "exec", provider: "fixture", id: "gateway-token" },
        },
      },
    },
    {},
  );
  expect(call).not.toHaveBeenCalled();
  expect(findings).toContainEqual(
    expect.objectContaining({ severity: "info", fixHint: expect.stringContaining("--allow-exec") }),
  );
});
