import { request } from "node:http";
import { expect, it, vi } from "vitest";
import { startRestartStressProvider } from "../../scripts/perf/team-shape-restart-provider.ts";

it("rejects unsupported provider targets and pins the Responses upstream", async () => {
  const upstream = vi.fn<typeof fetch>().mockImplementation(async () => new Response("synthetic"));
  vi.stubGlobal("fetch", upstream);
  const provider = await startRestartStressProvider({
    dry: false,
    model: "approved-stress-model",
    onActivity() {},
    onSustainedRateLimit() {},
  });
  const address = new URL(provider.baseUrl);
  const post = (target: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          hostname: address.hostname,
          port: address.port,
          path: target,
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer synthetic" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "stress-primary", input: "INPUT_test" }));
    });
  try {
    expect(await post("/unexpected-provider-target")).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    expect(await post("/v1/responses")).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    const body = upstream.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    expect(JSON.parse(body)).toMatchObject({
      model: "approved-stress-model",
    });
  } finally {
    await provider.close();
    vi.unstubAllGlobals();
  }
});
