import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  fetchClawHubPromotions: vi.fn(),
}));

vi.mock("../../infra/clawhub.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/clawhub.js")>("../../infra/clawhub.js");
  return {
    ...actual,
    fetchClawHubPromotions: mocks.fetchClawHubPromotions,
  };
});

const { promosListCommand } = await import("./list.js");

function makeRuntime() {
  const lines: string[] = [];
  const runtime = {
    log: vi.fn((line: string) => lines.push(line)),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
  return { runtime, lines };
}

const promotion = {
  slug: "spring-models",
  title: "Free Example models",
  blurb: "A limited-time offer.",
  sponsor: "Example",
  status: "active",
  active: true,
  startsAt: Date.now() - 1_000,
  endsAt: Date.now() + 3 * 86_400_000,
  provider: "openrouter",
  models: [
    { modelRef: "openrouter/example/model-alpha", alias: "Model Alpha", suggestedDefault: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("promosListCommand", () => {
  it("prints promotions with models and the claim command", async () => {
    mocks.fetchClawHubPromotions.mockResolvedValue([promotion]);
    const { runtime, lines } = makeRuntime();

    await promosListCommand({}, runtime);

    const output = lines.join("\n");
    expect(output).toContain("Free Example models — Example");
    expect(output).toContain("openrouter/example/model-alpha (Model Alpha) — suggested default");
    expect(output).toContain("openclaw promos claim spring-models");
  });

  it("prints an empty-state line when nothing is live", async () => {
    mocks.fetchClawHubPromotions.mockResolvedValue([]);
    const { runtime, lines } = makeRuntime();

    await promosListCommand({}, runtime);

    expect(lines.join("\n")).toContain("No active promotions");
  });

  it("emits JSON with --json", async () => {
    mocks.fetchClawHubPromotions.mockResolvedValue([promotion]);
    const { runtime, lines } = makeRuntime();

    await promosListCommand({ json: true }, runtime);

    const parsed = JSON.parse(lines.join("\n")) as { promotions: Array<{ slug: string }> };
    expect(parsed.promotions[0]?.slug).toBe("spring-models");
  });
});
