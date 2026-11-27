import { describe, expect, it, vi } from "vitest";
import type { OpenClawIdService } from "../openclaw-id/service.js";
import { handleOpenClawIdDeviceMail } from "./openclaw-id-device-mail.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const relay = vi.hoisted(() => ({ failure: new Error("unset") as Error }));
// mock-isolation: the relay's own wire contract is covered by device-mail-relay.test.ts.
vi.mock("../openclaw-id/device-mail-relay.js", () => ({
  relayDeviceMail: async () => {
    throw relay.failure;
  },
}));

const idToken = "synthetic-id-token-value";
const signature = "synthetic-signature-value";

async function failedCall(failure: Error) {
  relay.failure = failure;
  const warn = vi.fn();
  let response: { ok: boolean; error?: { code: string; retryable?: boolean } } | undefined;
  const link = { linked: true, clawId: "12".repeat(16), ownerDevices: [] };
  await handleOpenClawIdDeviceMail(
    {
      params: { operation: "receive", body: "", after: "0", idToken, signature },
      client: { internal: { isLocalClient: true } },
      respond: (ok: boolean, _payload: unknown, error?: { code: string; retryable?: boolean }) => {
        response = { ok, error };
      },
      context: {
        getRuntimeConfig: () => ({
          gateway: { openclawId: { discoveryUrl: "https://discovery.example.test" } },
        }),
        logGateway: { warn },
      },
    } as unknown as GatewayRequestHandlerOptions,
    {
      prepareOwnerClientCheck: async () => () => true,
      linkStatus: async () => link,
    } as unknown as OpenClawIdService,
  );
  return { response: response!, lines: warn.mock.calls.map(([line]) => String(line)) };
}

describe("owner-device mail relay failures", () => {
  it("logs the operation and the real cause without request credentials", async () => {
    const aborted = new DOMException("This operation was aborted", "AbortError");
    const { response, lines } = await failedCall(aborted);
    expect(response).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
    expect(lines).toEqual([
      "openclaw-id: device mail receive failed: AbortError: This operation was aborted",
    ]);
  });

  it("includes a network cause code but never the token or signature", async () => {
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error(`connect ${idToken}`), { code: "ECONNRESET" }),
    });
    const { lines } = await failedCall(failure);
    expect(lines).toEqual([
      "openclaw-id: device mail receive failed: TypeError: fetch failed (ECONNRESET)",
    ]);
    expect(lines.join("\n")).not.toContain(idToken);
    expect(lines.join("\n")).not.toContain(signature);
  });
});
