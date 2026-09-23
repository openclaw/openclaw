import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  events: [] as string[],
  connect: vi.fn(),
  create: vi.fn(),
  startGateway: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  default: { readFile: async () => JSON.stringify({ gateway: {} }) },
}));
vi.mock("../../extensions/qa-lab/api.js", () => ({ buildQaGatewayConfig: () => ({}) }));
vi.mock("../e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.js", () => ({
  MODEL_REF: "fixture/model",
}));
vi.mock("../e2e/qa-lab/runtime/skill-library-wire-fixture.js", () => ({
  createSkillLibraryWireInstance: fixture.create,
  SKILL_LIBRARY_ALICE: "alice@example.invalid",
  SKILL_LIBRARY_BOB: "bob@example.invalid",
  SKILL_LIBRARY_WRITER_SCOPES: ["operator.read", "operator.write"],
  SkillLibraryWireClient: { connect: fixture.connect },
}));
import { runProfileWireProof } from "../e2e/qa-lab/runtime/profile-binding-wire-fixture.js";

beforeEach(() => {
  fixture.events.length = 0;
  fixture.connect.mockReset();
  fixture.startGateway.mockReset().mockImplementation(async () => {
    fixture.events.push("start");
  });
  fixture.cleanup.mockReset().mockImplementation(async () => {
    fixture.events.push("instance");
  });
  fixture.create.mockReset().mockResolvedValue({
    state: { envVars: {}, workspaceDir: "fixture-workspace", writeConfig: async () => {} },
    env: {},
    configPath: "fixture-config",
    port: 1234,
    gatewayToken: "fixture-token",
    startGateway: fixture.startGateway,
    cleanup: fixture.cleanup,
  });
  fixture.connect.mockImplementation(async (_instance, options) => {
    const index = fixture.connect.mock.calls.length;
    return {
      client: {
        request: async () => ({ profile: { id: options?.email ?? "admin" } }),
        close: async () => {
          fixture.events.push(`client-${index}`);
        },
      },
      hello: {
        server: { buildId: "fixture-build" },
        auth: {
          scopes:
            options?.scopes ??
            (options?.email ? ["operator.read", "operator.write"] : ["operator.admin"]),
        },
      },
    };
  });
});
const provider = () =>
  Promise.resolve({
    baseUrl: "http://fixture.invalid",
    release: () => {
      fixture.events.push("release");
    },
    stop: async () => {
      fixture.events.push("provider");
    },
  });

describe("profile fixture dependent teardown admission", () => {
  it("keeps default callers' reverse-client and state cleanup order", async () => {
    await runProfileWireProof(provider, async () => {
      fixture.events.push("body");
    });
    expect(fixture.events).toEqual([
      "start",
      "body",
      "release",
      "client-4",
      "client-3",
      "client-2",
      "client-1",
      "instance",
      "provider",
    ]);
  });

  it("cleans the acquired instance when provider startup rejects", async () => {
    const error = new Error("provider startup");
    await expect(
      runProfileWireProof(
        async () => {
          throw error;
        },
        async () => {},
      ),
    ).rejects.toBe(error);
    expect(fixture.events).toEqual(["instance"]);
  });

  it("releases acquired provider and state after preparation fails", async () => {
    const error = new Error("preparation");
    await expect(
      runProfileWireProof(
        provider,
        async () => {},
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(fixture.events).toEqual(["release", "instance", "provider"]);
  });

  it("preserves all dependent state for an unjoined command while releasing inference needed to drain", async () => {
    const original = new Error("command process tree did not join");
    let joined = true;
    const result = runProfileWireProof(
      provider,
      async () => {
        joined = false;
        throw original;
      },
      undefined,
      () => joined,
    );
    await expect(result).rejects.toMatchObject({ errors: [original, expect.any(Error)] });
    expect(fixture.events).toEqual(["start", "release"]);
  });

  it("does not report successful proof when a borrower remains without a body error", async () => {
    await expect(
      runProfileWireProof(
        provider,
        async () => {},
        undefined,
        () => false,
      ),
    ).rejects.toThrow("retained state for unjoined borrowers");
    expect(fixture.events).toEqual(["start", "release"]);
  });

  it("keeps the original failure and attempts every default cleanup owner", async () => {
    const original = new Error("body");
    const cleanup = new Error("instance cleanup");
    fixture.cleanup.mockImplementation(async () => {
      fixture.events.push("instance");
      throw cleanup;
    });
    await expect(
      runProfileWireProof(provider, async () => {
        throw original;
      }),
    ).rejects.toMatchObject({ errors: [original, cleanup] });
    expect(fixture.events.at(-1)).toBe("provider");
  });
});
