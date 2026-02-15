import { describe, expect, it, vi } from "vitest";
import { getStatusSummary } from "../../commands/status.js";
import { healthHandlers } from "./health.js";

vi.mock("../../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));

describe("gateway healthHandlers.status scope handling", () => {
  it("requests redacted status for non-admin clients", async () => {
    const respond = vi.fn();
    await healthHandlers.status({
      respond,
      client: { connect: { role: "operator", scopes: ["operator.read"] } },
    } as Parameters<(typeof healthHandlers)["status"]>[0]);

    expect(vi.mocked(getStatusSummary)).toHaveBeenCalledWith({ includeSensitive: false });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("requests full status for admin clients", async () => {
    const respond = vi.fn();
    await healthHandlers.status({
      respond,
      client: { connect: { role: "operator", scopes: ["operator.admin"] } },
    } as Parameters<(typeof healthHandlers)["status"]>[0]);

    expect(vi.mocked(getStatusSummary)).toHaveBeenCalledWith({ includeSensitive: true });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });
});
