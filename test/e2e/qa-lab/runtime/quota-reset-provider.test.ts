import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, it, vi, type TestContext } from "vitest";
import WebSocket from "ws";
import * as testInstance from "../../../helpers/openclaw-test-instance.js";
import { createQuotaResetFixture, MARKER, startQuotaProvider } from "./quota-reset.test-support.js";

it("prints bounded readiness receipts from the quota failure hook before Gateway logs", async (context) => {
  const instance = await testInstance.createOpenClawTestInstance({
    name: "quota-failure-receipt",
    port: 1,
  });
  context.onTestFinished(() => instance.cleanup());
  const diagnostic: testInstance.GatewayReadinessDiagnostic = {
    probe: "GET /readyz",
    startedAtMs: 0,
    deadlineMs: 29,
    elapsedMs: 29,
    outcome: "timeout",
    attempts: 3,
    probes: [],
    omittedProbes: 0,
    lastProbe: { attempt: 3, phase: "headers", elapsedMs: 9, error: "timeout" },
    lastFailedResponse: {
      attempt: 1,
      phase: "body",
      elapsedMs: 0,
      status: 502,
      error: "invalid-json",
    },
    child: { pid: null, exitCode: null, signalCode: null },
    logs: { stdout: "retained-only log", stderr: "" },
  };
  const failure = new Error("synthetic startup failure");
  const gateway = {
    ...instance,
    readiness: [diagnostic],
    cli: vi
      .fn<typeof instance.cli>()
      .mockResolvedValue({ code: 0, signal: null, stdout: "", stderr: "" }),
    startGateway: vi.fn<typeof instance.startGateway>().mockRejectedValue(failure),
  };
  instance.stdout.push("quota fixture stdout");
  const createInstance = vi
    .spyOn(testInstance, "createOpenClawTestInstance")
    .mockResolvedValue(gateway);
  const failed = vi.fn<TestContext["onTestFailed"]>();
  const print = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      createQuotaResetFixture({ ...context, onTestFailed: failed }, { source: "wham" }),
    ).rejects.toBe(failure);
    expect(failed).toHaveBeenCalledOnce();
    await failed.mock.calls[0]![0](context);
    expect(print.mock.calls).toEqual([
      [testInstance.formatGatewayReadinessDiagnostic(diagnostic)],
      [gateway.logs()],
    ]);
    const receipt = String(print.mock.calls[0]![0]);
    expect(Buffer.byteLength(receipt)).toBeLessThan(1_024);
    expect(receipt).toContain('"status":502');
    expect(receipt).toContain('"error":"invalid-json"');
    expect(receipt).toContain('"error":"timeout"');
    expect(receipt).not.toContain("retained-only log");
    expect(receipt).not.toContain("probes");
  } finally {
    createInstance.mockRestore();
    print.mockRestore();
  }
});

it.each(["http", "websocket"] as const)(
  "keeps the catalog held through auxiliary %s success until the primary reply",
  async (transport) => {
    const provider = await startQuotaProvider("codex_rate_limits", MARKER);
    const hold = provider.holdNextCatalog();
    const catalog = fetch(`${provider.baseUrl}/catalog/models`).then((response) => response.json());
    const request = async (model: string, path = "/v1/responses", generate?: boolean) => {
      const body = JSON.stringify({ type: "response.create", model, input: [], generate });
      if (transport === "http") {
        const response = await fetch(`${provider.baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('"type":"response.completed"');
        return;
      }
      const socket = new WebSocket(`${provider.baseUrl.replace("http:", "ws:")}${path}`);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.on("message", (raw) => {
            const event: unknown = JSON.parse(rawDataToString(raw));
            if (
              event &&
              typeof event === "object" &&
              "type" in event &&
              event.type === "response.completed"
            ) {
              resolve();
            }
          });
          socket.once("open", () => socket.send(body));
        });
      } finally {
        if (socket.readyState !== WebSocket.CLOSED) {
          const closed = once(socket, "close");
          socket.terminate();
          await closed;
        }
      }
    };
    try {
      const captured = await hold.arrived;
      provider.setPhase("restored");
      const observed = vi.fn(() => hold.release());
      provider.observeNextSuccess(observed, { model: "gpt-5.5", path: "/v1/responses" });

      await request("gpt-5.6-luna");
      expect(observed).not.toHaveBeenCalled();
      expect(captured.releasedAt).toBeUndefined();
      await request("gpt-5.5", "/quota-backup/responses");
      expect(observed).not.toHaveBeenCalled();
      expect(captured.releasedAt).toBeUndefined();

      if (transport === "websocket") {
        await request("gpt-5.5", "/v1/responses", false);
        expect(observed).not.toHaveBeenCalled();
        expect(captured.releasedAt).toBeUndefined();
      }

      await request("gpt-5.5", "/v1/responses?fixture=primary");
      expect(observed).toHaveBeenCalledTimes(1);
      await catalog;
      expect(captured.releaseReason).toBe("explicit");
      await request("gpt-5.5");
      expect(observed).toHaveBeenCalledTimes(1);
      expect(provider.errors).toEqual([]);
    } finally {
      hold.release();
      try {
        await catalog;
      } finally {
        await provider.stop();
      }
    }
  },
);
