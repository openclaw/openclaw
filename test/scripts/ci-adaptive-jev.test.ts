import { afterEach, assert, expect, it, vi } from "vitest";
import { rankAdaptiveJev } from "../../scripts/lib/ci-adaptive-jev.mjs";

const context = {
  repository: "example/project",
  revision: "a".repeat(40),
  tree: "b".repeat(40),
  configDigest: "c".repeat(64),
  lockDigest: "d".repeat(64),
  environmentDigest: "e".repeat(64),
};
const files = [
  { file: "src/example.test.ts", project: "first", pool: "threads" },
  { file: "src/example.test.ts", project: "second", pool: "forks" },
];
const request = {
  version: 1,
  context,
  files,
  changedFiles: ["src/example.ts"],
  outcomes: "do-not-send",
};
const answer = (score = 0.8) => ({ type: "noul", noul: score });
const response = () => ({
  model: "jev-1.14.0",
  answers: { q001: answer(0.2), q000: answer() },
  usage: { input_tokens: 100, output_tokens: 10 },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps every file without making a request when the key is missing", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const result = await rankAdaptiveJev(request, "");
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.scheduledFiles).toEqual(files);
  expect(result.rows.map((row) => row.score)).toEqual([null, null]);
  expect(result.fallbackReason).toBe("missing-api-key");
  expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, complete: true });
});

it("maps reordered complete answers by opaque ID and sends only path inputs", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
  vi.stubGlobal("fetch", fetcher);
  const result = await rankAdaptiveJev(request, "fixture-key");
  expect(result.rows).toMatchObject([
    { ...files[0], score: 0.8 },
    { ...files[1], score: 0.2 },
  ]);
  expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10, complete: true });
  const [url, requestOptions] = fetcher.mock.calls[0]!;
  const options = requestOptions!;
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(options.redirect).toBe("error");
  expect(options.headers).toMatchObject({ Authorization: "Bearer fixture-key" });
  assert(typeof options.body === "string");
  const payload = JSON.parse(options.body);
  expect(payload.state).toEqual({ changedFiles: ["src/example.ts"] });
  expect(payload.questions.q000.instructions.test).toEqual(files[0]);
  expect(Object.keys(payload.questions)).toEqual(["q000", "q001"]);
  expect(JSON.stringify(result)).not.toContain("fixture-key");
  expect(options.body).not.toContain("do-not-send");
});

it.each([
  { ...response(), answers: { q000: answer() } },
  { ...response(), answers: { ...response().answers, extra: answer() } },
  { ...response(), model: "jev-latest" },
  { ...response(), answers: { q000: answer(2), q001: answer() } },
  { ...response(), answers: { q000: { type: "score", score: 0.8 }, q001: answer() } },
  { ...response(), usage: { input_tokens: -1, output_tokens: 0 } },
])("retains the full baseline for an invalid complete response %#", async (body) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body)),
  );
  const result = await rankAdaptiveJev(request, "fixture-key");
  expect(result.rows.map((row) => row.score)).toEqual([null, null]);
  expect(result.scheduledFiles).toEqual(files);
  expect(result.fallbackReason).toBe("provider-unavailable-or-invalid");
  expect(result.usage.complete).toBe(false);
  expect(result.usage.inputTokens).toBe(body.usage.input_tokens < 0 ? 0 : 100);
});

it.each([
  () => new Response("secret-sentinel", { status: 401 }),
  () => new Response("not-json"),
  () => new Response("x".repeat(65537)),
  () => {
    throw new Error("secret-sentinel");
  },
])("does not export provider errors or oversized bodies %#", async (respond) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond()),
  );
  const result = await rankAdaptiveJev(request, "fixture-key");
  expect(result.fallbackReason).toBe("provider-unavailable-or-invalid");
  expect(JSON.stringify(result)).not.toContain("secret-sentinel");
});

it("uses one deadline across batches and discards partial scores while retaining known usage", async () => {
  vi.useFakeTimers();
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 6000);
        });
        return Response.json({
          model: "jev-1.14.0",
          answers: Object.fromEntries(
            Array.from({ length: 25 }, (_, i) => [`q${String(i).padStart(3, "0")}`, answer()]),
          ),
          usage: { input_tokens: 123, output_tokens: 4 },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new Error("timeout")), {
          once: true,
        });
      });
    }),
  );
  const inventory = Array.from({ length: 26 }, (_, i) => ({
    file: `src/test-${i}.test.ts`,
    project: "unit",
    pool: "threads",
  }));
  const pending = rankAdaptiveJev({ ...request, files: inventory }, "fixture-key");
  await vi.advanceTimersByTimeAsync(6000);
  expect(calls).toBe(2);
  await vi.advanceTimersByTimeAsync(4000);
  const result = await pending;
  expect(result.rows).toHaveLength(26);
  expect(result.rows.every((row) => row.score === null)).toBe(true);
  expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 4, complete: false });
  expect(result.requests).toBe(2);
});
