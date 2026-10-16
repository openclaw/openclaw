import { afterEach, expect, it, vi } from "vitest";
import * as gateway from "../gateway/call.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import { createModelReferenceCheck } from "./doctor-model-reference-check.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "uses only prepared Gateway warnings in Doctor (offline=%s)",
  async (offline) => {
    vi.spyOn(gateway, "isImplicitLocalGatewayTarget").mockResolvedValue(true);
    vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
      pid: 123,
      port: 19568,
      createdAt: "fixture",
    });
    const call = vi.spyOn(gateway, "callGateway");
    if (offline) {
      call.mockRejectedValue(new Error("Gateway offline"));
    } else {
      call.mockResolvedValue({
        models: [],
        providerOutcomes: [
          { provider: "ollama", status: "ready", unlistedConfiguredModelIds: ["qwen3:8bb"] },
        ],
      });
    }
    const findings = await createModelReferenceCheck().detect({
      mode: "lint",
      cfg: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    expect(findings.filter((finding) => finding.target === "ollama/qwen3:8bb")).toEqual(
      offline
        ? []
        : [
            expect.objectContaining({
              severity: "warning",
              fixHint: expect.stringContaining("Pull or download it on that server"),
            }),
          ],
    );
    expect(call).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: "models.list",
        sharedStateMode: "read-only",
        params: { view: "all", includeDetails: true, preparedOnly: true },
      }),
    );
  },
);

it.each([
  [
    "publishes the id",
    { models: [{ id: "gemini-flash-lite-latest", name: "x", provider: "google" }] },
    false,
  ],
  [
    "does not publish the id",
    { models: [{ id: "gemini-2.5-flash", name: "x", provider: "google" }] },
    true,
  ],
  ["cannot answer", new Error("Gateway offline"), true],
])(
  "uses the selected Gateway's published ids for membership when it %s",
  async (_label, response, reported) => {
    vi.spyOn(gateway, "isImplicitLocalGatewayTarget").mockResolvedValue(true);
    vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
      pid: 123,
      port: 19568,
      createdAt: "fixture",
    });
    const call = vi.spyOn(gateway, "callGateway");
    if (response instanceof Error) {
      call.mockRejectedValue(response);
    } else {
      call.mockResolvedValue(response);
    }
    const ref = "google/gemini-flash-lite-latest";
    const findings = await createModelReferenceCheck().detect({
      mode: "lint",
      env: {},
      cfg: { agents: { defaults: { imageModel: ref } } },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    expect(findings.filter((finding) => finding.target === ref)).toEqual(
      reported
        ? [
            expect.objectContaining({
              severity: "info",
              requirement: "a provider-supported model id",
            }),
          ]
        : [],
    );
    expect(call).toHaveBeenCalledOnce();
  },
);

it("does not execute Gateway secret providers without Doctor's allow-exec opt-in", async () => {
  vi.spyOn(gateway, "isImplicitLocalGatewayTarget").mockResolvedValue(true);
  vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
    pid: 123,
    port: 19568,
    createdAt: "fixture",
  });
  const call = vi.spyOn(gateway, "callGateway").mockResolvedValue({ models: [] });
  const findings = await createModelReferenceCheck().detect({
    mode: "lint",
    env: {},
    cfg: {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "exec", provider: "fixture", id: "gateway-token" },
        },
      },
    },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
  expect(call).not.toHaveBeenCalled();
  expect(findings).toContainEqual(
    expect.objectContaining({ severity: "info", fixHint: expect.stringContaining("--allow-exec") }),
  );
});
