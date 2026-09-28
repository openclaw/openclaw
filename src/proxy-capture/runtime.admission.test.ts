import { expect, it, vi } from "vitest";
import type { DebugProxySettings } from "./env.js";
import { captureHttpExchangeAsync, captureWsEventAsync } from "./runtime.js";

const admissionFailure = vi.hoisted(() => new Error("synthetic capture admission rejected"));

vi.mock("./runtime-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-owner.js")>()),
  resolveCaptureOwner: () => {
    throw admissionFailure;
  },
}));

const settings: DebugProxySettings = {
  enabled: true,
  required: false,
  dbPath: "/synthetic/capture.sqlite",
  blobDir: "/synthetic/blobs",
  certDir: "/synthetic/certs",
  sessionId: "admission-fixture",
  sourceProcess: "fixture",
};

it.each(["HTTP", "WebSocket"] as const)(
  "returns %s owner admission failure as an observed rejecting Promise",
  async (kind) => {
    const result =
      kind === "HTTP"
        ? captureHttpExchangeAsync(
            {
              url: "https://synthetic.invalid/capture",
              method: "GET",
              response: new Response("fixture"),
            },
            settings,
          )
        : captureWsEventAsync(
            {
              url: "wss://synthetic.invalid/capture",
              direction: "outbound",
              kind: "ws-frame",
              flowId: "fixture",
              payload: "fixture",
            },
            settings,
          );
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toBe(admissionFailure);
  },
);
