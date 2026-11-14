import { beforeEach, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({ fetchClawHubPromotions: vi.fn() }));

vi.mock("../../infra/clawhub-promotions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-promotions.js")>()),
  fetchClawHubPromotions: mocks.fetchClawHubPromotions,
}));

const { ClawHubRequestError } = await import("../../infra/clawhub-client.js");
const { promosListCommand } = await import("./list.js");

const runtime = {
  log: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn(),
  exit: vi.fn(),
  writeStdout: vi.fn(),
  writeJson: vi.fn(),
} satisfies OutputRuntimeEnv;
const lines = () => runtime.log.mock.calls.map((args) => args.map(String).join(" "));
const unavailable = new ClawHubRequestError({ path: "/api/v1/promotions", status: 404, body: "" });

const promotion = {
  slug: "spring-models",
  title: "Free\u001b[31m models",
  blurb: "Offer\u001b]0;pwned\u0007 text",
  sponsor: "Example",
  status: "active",
  active: true,
  startsAt: Date.now() - 1_000,
  endsAt: Date.now() + 3 * 86_400_000,
  models: [{ modelRef: "openrouter/example/alpha", alias: "Alpha", suggestedDefault: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchClawHubPromotions.mockResolvedValue([promotion]);
});

it.each([false, true])("returns promotions as JSON (unavailable: %s)", async (isUnavailable) => {
  if (isUnavailable) {
    mocks.fetchClawHubPromotions.mockRejectedValue(unavailable);
  }
  await promosListCommand({ json: true }, runtime);
  expect(lines()).toEqual([]);
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual({
    promotions: isUnavailable ? [] : [promotion],
  });
});

it.each([
  { remainingMs: 60 * 60 * 1_000, label: "ends today" },
  { remainingMs: 25 * 60 * 60 * 1_000, label: "1 day left" },
])("reports $label", async ({ remainingMs, label }) => {
  mocks.fetchClawHubPromotions.mockResolvedValue([
    { ...promotion, endsAt: Date.now() + remainingMs },
  ]);
  await promosListCommand({}, runtime);
  expect(lines()[0]).toContain(`(${label})`);
});

it("prints an empty-state line when nothing is live", async () => {
  mocks.fetchClawHubPromotions.mockResolvedValue([]);
  await promosListCommand({}, runtime);
  expect(lines()).toEqual(["No active promotions right now."]);
});

it("reports a friendly unavailable state when the promotions route is not deployed", async () => {
  mocks.fetchClawHubPromotions.mockRejectedValue(unavailable);
  await promosListCommand({}, runtime);
  expect(lines()).toEqual(["Promotions are not available from ClawHub yet."]);
});

it("strips terminal control sequences from remote promotion text", async () => {
  await promosListCommand({}, runtime);
  const output = lines().join("\n");
  expect(output).not.toContain("\u001b");
  expect(output).toContain("Free");
});
