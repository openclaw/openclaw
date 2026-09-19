import { describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "./fetch-guard.js";

type LookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

const createPublicLookup = (): LookupFn =>
  vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

describe("fetchWithSsrFGuard redirect policy", () => {
  it("rejects unsafe cross-origin redirect bodies before replay when requested", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: "https://cdn.example.com/upload-2" },
      }),
    );

    await expect(
      fetchWithSsrFGuard({
        url: "https://api.example.com/upload",
        fetchImpl,
        lookupFn,
        rejectCrossOriginUnsafeRedirectReplay: true,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"secret":"123"}',
        },
      }),
    ).rejects.toThrow("Refusing to follow cross-origin redirect for POST request body");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects contradictory unsafe cross-origin redirect policies before fetching", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchWithSsrFGuard({
        url: "https://api.example.com/upload",
        fetchImpl,
        allowCrossOriginUnsafeRedirectReplay: true,
        rejectCrossOriginUnsafeRedirectReplay: true,
      }),
    ).rejects.toThrow("Cross-origin unsafe redirect replay cannot be both allowed and rejected");

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
