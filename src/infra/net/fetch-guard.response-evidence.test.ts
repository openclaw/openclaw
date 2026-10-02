import { expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "./fetch-guard.js";

it("records response headers before blocking a redirect to a private host", async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:6379/" },
    }),
  );
  const responses: number[] = [];
  await expect(
    fetchWithSsrFGuard({
      url: "https://public.example/start",
      fetchImpl,
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      onResponse: (status) => {
        responses.push(status);
      },
    }),
  ).rejects.toThrow(/private|internal|blocked/i);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(responses).toEqual([302]);
});
